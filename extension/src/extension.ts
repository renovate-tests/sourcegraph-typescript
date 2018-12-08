// Polyfill
import { URL as _URL, URLSearchParams as _URLSearchParams } from 'whatwg-url'
// @ts-ignore
Object.assign(_URL, self.URL)
Object.assign(self, { URL: _URL, URLSearchParams: _URLSearchParams })

import {
    createMessageConnection,
    MessageConnection,
    toSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from '@sourcegraph/vscode-ws-jsonrpc'
import { create } from 'abortable-rx'
import { AsyncIterableX, merge } from 'ix/asynciterable/index'
import { MergeAsyncIterable } from 'ix/asynciterable/merge'
import { _catch, _finally, filter, map, scan } from 'ix/asynciterable/pipe/index'
import { fromPairs } from 'lodash'
import Semaphore from 'semaphore-async-await'
import * as sourcegraph from 'sourcegraph'
import {
    DefinitionRequest,
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    HoverRequest,
    ImplementationRequest,
    InitializeParams,
    InitializeRequest,
    Location,
    LogMessageNotification,
    ReferenceContext,
    ReferenceParams,
    ReferencesRequest,
    TextDocumentPositionParams,
} from 'vscode-languageserver-protocol'
import { getOrCreateAccessToken } from './auth'
import { findPackageDependentsWithNpm, findPackageDependentsWithSourcegraph, findPackageName } from './dependencies'
import { resolveRev, SourcegraphInstanceOptions } from './graphql'
import { convertHover, convertLocation, convertLocations } from './lsp-conversion'
import { resolveServerRootUri, rewriteUris, toServerTextDocumentUri, toSourcegraphTextDocumentUri } from './uris'
import { asArray, observableFromAsyncIterable, throwIfAborted, throwIfAbortError } from './util'

const connectionsByRootUri = new Map<string, Promise<MessageConnection>>()

const isTypeScriptFile = (textDocumentUri: URL): boolean => /\.m?(?:t|j)sx?$/.test(textDocumentUri.hash)

const documentSelector: sourcegraph.DocumentSelector = [
    { language: 'typescript' },
    { language: 'javascript' },
    { language: 'json' },
]

export async function activate(): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, 10))

    const accessToken = await getOrCreateAccessToken()

    /** Adds the access token to the given server raw HTTP API URI, if available */
    function authenticateUri(uri: URL): URL {
        const authenticatedUri = new URL(uri.href)
        if (accessToken) {
            authenticatedUri.username = accessToken
        }
        return authenticatedUri
    }

    /**
     * @param rootUri The server HTTP root URI
     */
    async function connect(rootUri: URL): Promise<MessageConnection> {
        const serverUrl: unknown = sourcegraph.configuration.get().get('typescript.serverUrl')
        if (typeof serverUrl !== 'string') {
            throw new Error(
                'Setting typescript.serverUrl must be set to the WebSocket endpoint of the TypeScript language service'
            )
        }
        const socket = new WebSocket(serverUrl)
        socket.addEventListener('close', event => {
            console.warn('WebSocket connection to TypeScript backend closed', event)
        })
        socket.addEventListener('error', event => {
            console.error('WebSocket error', event)
        })
        const rpcWebSocket = toSocket(socket)
        const connection = createMessageConnection(
            new WebSocketMessageReader(rpcWebSocket),
            new WebSocketMessageWriter(rpcWebSocket),
            console
        )
        connection.onNotification(LogMessageNotification.type, ({ type, message }) => {
            // Blue background for the "TypeScript server" prefix
            const args = [
                // console.info() doesn't get a visual distinction or filter in Chrome anymore
                (type === 3 ? 'ℹ️' : '') + '%cTypeScript backend%c %s',
                'background-color: blue; color: white',
                '',
                message,
            ]
            switch (type) {
                case 1:
                    console.error(...args)
                    break
                case 2:
                    console.warn(...args)
                    break
                case 3:
                    console.info(...args)
                    break
                case 4:
                default:
                    console.log(...args)
                    break
            }
        })
        connection.listen()
        const event = await new Promise<Event>(resolve => {
            socket.addEventListener('open', resolve, { once: true })
            socket.addEventListener('error', resolve, { once: true })
        })
        if (event.type === 'error') {
            throw new Error(`The WebSocket to the TypeScript backend at ${serverUrl} could not not be opened`)
        }
        console.log(`WebSocket connection to TypeScript backend at ${serverUrl} opened`)
        const initializeParams: InitializeParams = {
            processId: 0,
            rootUri: rootUri.href,
            workspaceFolders: [{ name: '', uri: rootUri.href }],
            capabilities: {},
            initializationOptions: {
                // until workspace/configuration is allowed during initialize
                configuration: {
                    // The server needs to use the API to resolve repositories
                    'sourcegraph.url': sourcegraph.internal.sourcegraphURL.toString(),
                    ...fromPairs(
                        Object.entries(sourcegraph.configuration.get().value).filter(([key]) =>
                            key.startsWith('typescript.')
                        )
                    ),
                },
            },
        }
        console.log('Initializing TypeScript backend...')
        const initResult = await connection.sendRequest(InitializeRequest.type, initializeParams)
        console.log('TypeScript backend initialized', initResult)
        // Tell language server about all currently open text documents under this root
        for (const textDocument of sourcegraph.workspace.textDocuments) {
            if (!isTypeScriptFile(new URL(textDocument.uri))) {
                continue
            }
            const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(new URL(textDocument.uri)))
            if (!serverTextDocumentUri.href.startsWith(rootUri.href)) {
                continue
            }
            const didOpenParams: DidOpenTextDocumentParams = {
                textDocument: {
                    uri: serverTextDocumentUri.href,
                    languageId: textDocument.languageId,
                    text: textDocument.text,
                    version: 1,
                },
            }
            connection.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams)
        }
        return connection
    }

    /**
     * @param rootUri The server HTTP root URI
     */
    async function getOrCreateConnection(rootUri: URL): Promise<MessageConnection> {
        let connectionPromise = connectionsByRootUri.get(rootUri.href)
        if (!connectionPromise) {
            connectionPromise = connect(rootUri)
            connectionsByRootUri.set(rootUri.href, connectionPromise)
        }
        const connection = await connectionPromise
        connection.onClose(() => {
            connectionsByRootUri.delete(rootUri.href)
        })
        return connection
    }

    // Forward didOpen notifications
    sourcegraph.workspace.onDidOpenTextDocument.subscribe(async textDocument => {
        try {
            const textDocumentUri = new URL(textDocument.uri)
            if (!isTypeScriptFile(textDocumentUri)) {
                return
            }

            const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
            const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
            const connection = await getOrCreateConnection(serverRootUri)
            const didOpenParams: DidOpenTextDocumentParams = {
                textDocument: {
                    uri: serverTextDocumentUri.href,
                    languageId: textDocument.languageId,
                    text: textDocument.text,
                    version: 1,
                },
            }
            connection.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams)
        } catch (err) {
            console.error('Error handling didOpenTextDocument event', err)
        }
    })

    // Example of a Sourcegraph textdocument URI:
    // git://github.com/sourcegraph/extensions-client-common?80389224bd48e1e696d5fa11b3ec6fba341c695b#src/schema/graphqlschema.ts

    // Hover
    sourcegraph.languages.registerHoverProvider(documentSelector, {
        provideHover: async (textDocument, position) => {
            const textDocumentUri = new URL(textDocument.uri)
            const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
            const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
            const connection = await getOrCreateConnection(serverRootUri)
            const hoverResult = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri: serverTextDocumentUri.href },
                position,
            })
            rewriteUris(hoverResult, toSourcegraphTextDocumentUri)
            return convertHover(hoverResult)
        },
    })

    // Definition
    sourcegraph.languages.registerDefinitionProvider(documentSelector, {
        provideDefinition: async (textDocument, position) => {
            const textDocumentUri = new URL(textDocument.uri)
            const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
            const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
            const connection = await getOrCreateConnection(serverRootUri)
            const definitionResult = await connection.sendRequest(DefinitionRequest.type, {
                textDocument: { uri: serverTextDocumentUri.href },
                position,
            })
            rewriteUris(definitionResult, toSourcegraphTextDocumentUri)
            return convertLocations(definitionResult)
        },
    })

    // References
    sourcegraph.languages.registerReferenceProvider(documentSelector, {
        provideReferences: (textDocument, position) =>
            observableFromAsyncIterable(
                (async function*() {
                    const textDocumentUri = new URL(textDocument.uri)
                    const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
                    const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
                    const connection = await getOrCreateConnection(serverRootUri)

                    const context: ReferenceContext = {
                        includeDeclaration: false,
                    }

                    yield* merge(
                        // Same-repo references
                        (async function*() {
                            console.log('Searching for same-repo references')
                            const sameRepoReferences = asArray(
                                await connection.sendRequest(ReferencesRequest.type, {
                                    textDocument: { uri: serverTextDocumentUri.href },
                                    position,
                                    context,
                                })
                            )
                            console.log(`Found ${sameRepoReferences.length} same-repo references`)
                            yield sameRepoReferences
                        })(),
                        // Cross-repo references
                        // Find canonical source location
                        (async function*() {
                            console.log('Getting canonical definition for cross-repo references')
                            const definitions = asArray(
                                await connection.sendRequest(DefinitionRequest.type, {
                                    textDocument: { uri: serverTextDocumentUri.href },
                                    position,
                                })
                            )
                            console.log(`Got ${definitions.length} definitions`)
                            const instanceUrl = new URL(sourcegraph.internal.sourcegraphURL.toString())
                            const sgInstanceOptions: SourcegraphInstanceOptions = {
                                accessToken,
                                instanceUrl,
                            }
                            const findDependents =
                                instanceUrl.hostname === 'sourcegraph.com'
                                    ? findPackageDependentsWithNpm
                                    : findPackageDependentsWithSourcegraph

                            yield* new MergeAsyncIterable(
                                definitions.map(async function*(definition) {
                                    try {
                                        console.log(`Getting external references for definition`, definition)

                                        const definitionUri = new URL(definition.uri)

                                        const referenceParams: ReferenceParams = {
                                            textDocument: { uri: definitionUri.href },
                                            position: definition.range.start,
                                            context,
                                        }

                                        const packageName = await findPackageName(definitionUri)

                                        // Find dependent packages on the package
                                        const dependents = findDependents(packageName, sgInstanceOptions)

                                        // Search for references in each dependent
                                        const referencesInDependents = create<Location[]>((observer, signal) => {
                                            ;(async () => {
                                                const concurrencyLimit = new Semaphore(7)
                                                const waitGroup = new Set<Promise<void>>()
                                                for await (const repoName of dependents) {
                                                    throwIfAborted(signal)
                                                    await concurrencyLimit.acquire()
                                                    waitGroup.add(
                                                        (async () => {
                                                            try {
                                                                const commitID = await resolveRev(
                                                                    repoName,
                                                                    'HEAD',
                                                                    sgInstanceOptions
                                                                )
                                                                const dependentRootUri = authenticateUri(
                                                                    new URL(
                                                                        `${repoName}@${commitID}/-/raw/`,
                                                                        instanceUrl
                                                                    )
                                                                )
                                                                console.log(
                                                                    `Looking for external references in dependent repo ${repoName}`
                                                                )
                                                                const dependentConnection = await getOrCreateConnection(
                                                                    dependentRootUri
                                                                )
                                                                const referencesInDependent = asArray(
                                                                    await dependentConnection.sendRequest(
                                                                        ReferencesRequest.type,
                                                                        referenceParams
                                                                    )
                                                                )
                                                                console.log(
                                                                    `Found ${
                                                                        referencesInDependent.length
                                                                    } references in dependent repo ${repoName}`
                                                                )
                                                                observer.next(referencesInDependent)
                                                            } catch (err) {
                                                                throwIfAbortError(err)
                                                                console.error(
                                                                    `Error searching dependent repo "${repoName}" for references`,
                                                                    err
                                                                )
                                                            } finally {
                                                                concurrencyLimit.release()
                                                            }
                                                        })()
                                                    )
                                                }
                                                await Promise.all(waitGroup)
                                                observer.complete()
                                            })().catch(err => observer.error(err))
                                        })

                                        yield* AsyncIterableX.from<Location[]>(referencesInDependents)

                                        console.log('Done going through dependents')
                                    } catch (err) {
                                        throwIfAbortError(err)
                                        console.error(
                                            `Error searching for external references for definition`,
                                            definition,
                                            err
                                        )
                                    }
                                })
                            )
                        })()
                    ).pipe(
                        filter(chunk => chunk.length > 0),
                        // Rewrite URIs and convert from LSP to Sourcegraph Location
                        map(chunk =>
                            chunk.map(location =>
                                convertLocation({
                                    ...location,
                                    uri: toSourcegraphTextDocumentUri(new URL(location.uri)).href,
                                })
                            )
                        ),
                        // Aggregate individual chunks into a growing array (which is what Sourcegraph expects)
                        scan((allReferences, chunk) => allReferences.concat(chunk), [])
                    )
                })()
            ),
    })

    // Implementations
    sourcegraph.languages.registerImplementationProvider(documentSelector, {
        provideImplementation: async (textDocument, position) => {
            const textDocumentUri = new URL(textDocument.uri)
            const serverRootUri = authenticateUri(resolveServerRootUri(textDocumentUri))
            const serverTextDocumentUri = authenticateUri(toServerTextDocumentUri(textDocumentUri))
            const connection = await getOrCreateConnection(serverRootUri)
            const implementationParams: TextDocumentPositionParams = {
                textDocument: { uri: serverTextDocumentUri.href },
                position,
            }
            const implementationResult = await connection.sendRequest(ImplementationRequest.type, implementationParams)
            rewriteUris(implementationResult, toSourcegraphTextDocumentUri)
            return convertLocations(implementationResult)
        },
    })
}

// Learn what else is possible by visiting the [Sourcegraph extension documentation](https://github.com/sourcegraph/sourcegraph-extension-docs)
