import type {Tracer} from '@opentelemetry/api';
import {z} from 'zod';
import {type Cancel, Context, context, createTraceId} from '../context.js';
import {
    AppError,
    CancelledError,
    getErrorCode,
    getReadableError,
    toError,
} from '../errors.js';
import {JobManager} from '../job-manager.js';
import {log} from '../logger.js';
import {
    AsyncIteratorFactory,
    Channel,
    type ChannelWriter,
    toStream,
} from '../stream.js';
import type {Message, MessageHeaders} from '../transport/message.js';
import {
    catchConnectionClosed,
    type Connection,
} from '../transport/transport.js';
import {
    assertNever,
    type Brand,
    catchCancel,
    run,
    runAll,
    type Unsubscribe,
} from '../utils.js';
import {createUuid, Uuid, zUuid} from '../uuid.js';
import {
    createRpcHandlerClient,
    launchRpcHandlerServer,
    reconstructError,
    reportRpcError,
} from './rpc-handler.js';
import {
    createApi,
    getRequiredProcessor,
    handler,
    type Handler,
    type InferRpcClient,
    type Streamer,
} from './rpc.js';

export type StreamerApi<TState> = Record<
    string,
    Handler<TState, unknown, unknown> | Streamer<TState, unknown, unknown>
>;

export function launchRpcStreamerServer<T>(
    api: StreamerApi<T>,
    state: T,
    conn: Connection<Message>,
    serverName: string,
    tracer: Tracer
) {
    context().ensureActive();

    const client = createRpcHandlerClient(
        createRpcStreamerClientApi(),
        conn,
        () => ({...context().extract()})
    );

    function cleanup(reason: unknown) {
        unsub();
        serverApiState.close(reason);
        cancelCleanup();
    }

    const cancelCleanup = context().onEnd(cleanup);

    const unsub = conn.subscribe({
        next: () => Promise.resolve(),
        throw: () => Promise.resolve(),
        close: () =>
            cleanup(
                new CancelledError(
                    `${serverName} launchRpcStreamerServer: connection closed`,
                    'connection_closed'
                )
            ),
    });

    const serverApiState = new RpcStreamerServerApiState(
        state,
        new JobManager(),
        client,
        serverName,
        tracer
    );
    launchRpcHandlerServer(
        createRpcStreamerServerApi(api),
        serverApiState,
        conn,
        tracer
    );
}

type StreamId = Brand<Uuid, 'stream_id'>;
function createStreamId() {
    return createUuid() as StreamId;
}

function zStreamId() {
    return zUuid<StreamId>();
}

class RpcStreamerServerApiState<T> {
    constructor(
        public readonly state: T,
        public readonly jobManager: JobManager<StreamId>,
        public readonly client: RpcStreamerClientRpc,
        public readonly serverName: string,
        public readonly tracer: Tracer
    ) {}

    close(reason: unknown) {
        this.jobManager.finishAll(reason);
    }
}

export function toResponseLog(arg: unknown) {
    return JSON.stringify(arg)?.slice(0, 100);
}

export function toRequestLog(arg: unknown) {
    return JSON.stringify(arg)?.slice(0, 100);
}

function createRpcStreamerServerApi<TState>(api: StreamerApi<TState>) {
    return createApi<RpcStreamerServerApiState<TState>>()({
        handle: handler({
            req: z.object({name: z.string(), arg: z.unknown()}),
            res: z.unknown(),
            handle: async (state, req, ctx) => {
                const processor = getRequiredProcessor(api, req.name);
                if (processor.type !== 'handler') {
                    throw new AppError('processor must be a handler');
                }

                const callInfo = `handle_call ${state.serverName}.${req.name}(${toRequestLog(req.arg)}) [rid=${ctx.requestId}]`;

                try {
                    log.info(`${callInfo}...`);

                    const result = await processor.handle(
                        state.state,
                        req.arg,
                        ctx
                    );

                    log.info(`${callInfo} => ${toResponseLog(result)}`);

                    return result;
                } catch (error) {
                    log.error(toError(error), `${callInfo} failed`);
                    throw error;
                }
            },
        }),
        stream: handler({
            req: z.object({
                name: z.string(),
                arg: z.any(),
                streamId: zStreamId(),
            }),
            res: z.object({}),
            handle: async (state, {name, streamId, arg}, headers) => {
                const processor = getRequiredProcessor(api, name);
                if (processor.type !== 'streamer') {
                    throw new AppError('processor must be a streamer');
                }

                const callInfo = `handle ${state.serverName}.${name}(${toRequestLog(arg)}) [sid=${streamId}]`;

                log.info(`${callInfo}...`);

                const [ctx, cancelCtx] = context().createDetached({
                    span: `handle_stream ${name}(${toRequestLog(arg)})`,
                    attributes: {
                        'rpc.streamId': streamId,
                        'rpc.method': name,
                        'rpc.arg': toRequestLog(arg),
                    },
                });

                catchCancel(
                    state.jobManager.start(
                        streamId,
                        ctx,
                        cancelCtx,
                        async () => {
                            try {
                                for await (const value of processor.stream(
                                    state.state,
                                    arg,
                                    headers
                                )) {
                                    log.info(
                                        `${callInfo} => ${toResponseLog(value)}`
                                    );
                                    await catchConnectionClosed(
                                        state.client.next({streamId, value})
                                    );
                                }
                            } catch (error: unknown) {
                                reportRpcError(toError(error), callInfo);
                                // no point in sending throw if the stream was cancelled by client
                                if (!state.jobManager.isCancelled(streamId)) {
                                    await catchConnectionClosed(
                                        state.client.throw({
                                            streamId,
                                            message: getReadableError(error),
                                            code: getErrorCode(error),
                                        })
                                    );
                                }
                            } finally {
                                log.info(`${callInfo} finished`);

                                // no point in sending end if the stream was cancelled by client
                                if (!state.jobManager.isCancelled(streamId)) {
                                    await catchConnectionClosed(
                                        state.client.end({streamId})
                                    );
                                }

                                state.jobManager.finish(
                                    streamId,
                                    new AppError(`${callInfo} finished`)
                                );
                            }
                        }
                    )
                ).catch(error => {
                    log.error(error, `${callInfo} failed`);
                });

                return {streamId};
            },
        }),
        cancel: handler({
            req: z.object({streamId: zStreamId(), reason: z.string()}),
            res: z.object({}),
            handle: async (state, {streamId, reason}) => {
                state.jobManager.cancel(
                    streamId,
                    new CancelledError(
                        'stream cancellation requested by the client',
                        reason
                    )
                );

                return {};
            },
        }),
    });
}

class RpcStreamerClientApiState {
    constructor(
        private readonly server: InferRpcClient<
            ReturnType<typeof createRpcStreamerServerApi<unknown>>
        >
    ) {}

    private readonly subs = new Map<
        StreamId,
        {
            context: Context;
            method: string;
            writer: ChannelWriter<unknown>;
        }
    >();

    create(params: {
        streamId: StreamId;
        writer: ChannelWriter<unknown>;
        method: string;
        arg: unknown;
    }) {
        if (this.subs.has(params.streamId)) {
            throw new AppError(`stream ${params.streamId} already exists`);
        }

        this.subs.set(params.streamId, {
            context: context(),
            writer: params.writer,
            method: params.method,
        });
    }

    async next(streamId: StreamId, value: unknown) {
        const sub = this.getSub(streamId);
        await sub?.context.runChild(
            {
                span: 'next',
                attributes: {'rpc.next.value': toResponseLog(value)},
            },
            async () => {
                await sub.writer.next(value);
            }
        );
    }

    async throw(params: {streamId: StreamId; code: string; message: string}) {
        const sub = this.getSub(params.streamId);
        await sub?.context.runChild(
            {
                span: 'throw',
                attributes: {
                    'rpc.throw.code': params.code,
                    'rpc.throw.message': toResponseLog(params.message),
                },
            },
            async () => {
                await sub.writer.throw(
                    toError(
                        reconstructError({
                            message: params.message,
                            code: params.code,
                        })
                    )
                );
            }
        );
    }

    end(streamId: StreamId) {
        const sub = this.getSub(streamId);
        sub?.context.runChild({span: 'end'}, () => {
            sub.writer.end();
        });
    }

    finish(streamId: StreamId, reason: unknown) {
        const sub = this.subs.get(streamId);
        if (!sub) {
            return;
        }
        const {context, writer} = sub;
        this.subs.delete(streamId);
        context
            .run(() =>
                writer
                    .throw(
                        new CancelledError(
                            'RpcStreamerClientApiState.finish: context finished',
                            reason
                        )
                    )
                    .finally(() => writer.end())
            )
            .catch(error => {
                log.error(error, 'failed to finish the channel');
            });
    }

    finishAll(reason: unknown) {
        runAll([...this.subs.keys()].map(x => () => this.finish(x, reason)));
    }

    private getSub(streamId: StreamId) {
        const channel = this.subs.get(streamId);
        if (!channel) {
            log.warn(`unknown streamId: ${streamId}`);
            context().detach({span: 'getSub: cancel stream'}, () => {
                this.server
                    .cancel({
                        streamId: streamId,
                        reason: `unknown streamId: ${streamId}`,
                    })
                    .catch(error =>
                        log.error(
                            toError(error),
                            `failed to cancel stream ${streamId}`
                        )
                    );
            });
        }

        return channel;
    }
}

function createRpcStreamerClientApi() {
    return createApi<RpcStreamerClientApiState>()({
        next: handler({
            req: z.object({streamId: zStreamId(), value: z.unknown()}),
            res: z.object({}),
            handle: async (state, {streamId, value}) => {
                await state.next(streamId, value);

                return {};
            },
        }),
        throw: handler({
            req: z.object({
                streamId: zStreamId(),
                message: z.string(),
                code: z.string(),
            }),
            res: z.object({}),
            handle: async (state, {streamId, message, code}) => {
                await state.throw({streamId, message, code});

                return {};
            },
        }),
        end: handler({
            req: z.object({streamId: zStreamId()}),
            res: z.object({}),
            handle: async (state, {streamId}) => {
                state.end(streamId);

                return {};
            },
        }),
    });
}

type RpcStreamerClientRpc = InferRpcClient<
    ReturnType<typeof createRpcStreamerClientApi>
>;

export function createRpcStreamerClient<TApi extends StreamerApi<any>>(
    api: TApi,
    conn: Connection<Message>,
    getHeaders: () => MessageHeaders,
    clientTarget: string,
    tracer: Tracer
): InferRpcClient<TApi> {
    context().ensureActive();

    const server = createRpcHandlerClient(
        createRpcStreamerServerApi(api),
        conn,
        getHeaders
    );

    const clientApiState = new RpcStreamerClientApiState(server);
    launchRpcHandlerServer(
        createRpcStreamerClientApi(),
        clientApiState,
        conn,
        tracer
    );

    let cancelCleanup: Unsubscribe | undefined = undefined;
    function cleanup(reason: unknown) {
        unsub();
        clientApiState.finishAll(reason);
        cancelCleanup?.();
        conn.close();
    }

    cancelCleanup = context().onEnd(cleanup);

    const unsub = conn.subscribe({
        next: () => Promise.resolve(),
        throw: async error => clientApiState.finishAll(error),
        close: () => cleanup(new AppError('connection closed')),
    });

    function get(_target: unknown, nameOrSymbol: string | symbol) {
        if (typeof nameOrSymbol !== 'string') {
            return () => {
                throw new AppError('rpc client supports only string methods');
            };
        }

        const name = nameOrSymbol;

        // special case for client close
        if (name === 'close') {
            return () => {
                cleanup('RpcStreamerClient.close');
            };
        }

        const handler = api[name];
        if (!handler) {
            return () => {
                throw new AppError(`unknown rpc endpoint: ${name}`);
            };
        }

        return (arg: unknown, headers?: Partial<MessageHeaders>) => {
            context().ensureActive();

            // validate argument
            arg = handler.req.parse(arg);

            if (handler.type === 'handler') {
                const requestId = createTraceId();
                const [requestCtx, cancelRequestCtx] = context().createChild({
                    span: `call ${name}(${toRequestLog(arg)})`,
                    attributes: {
                        'rpc.requestId': requestId,
                        'rpc.method': name,
                        'rpc.arg': toRequestLog(arg),
                    },
                });
                return requestCtx
                    .run(async () => {
                        const callInfo = `call ${clientTarget}.${name}(${toRequestLog(arg)}) [rid=${requestId}]`;
                        log.info(`${callInfo}...`);
                        return server
                            .handle({name, arg}, headers)
                            .then(async result => {
                                log.info(
                                    `${callInfo} => ${toResponseLog(result)}`
                                );
                                return result;
                            })
                            .catch(async error => {
                                log.error(
                                    error,
                                    `${callInfo} failed: ${getReadableError(error)}`
                                );
                                throw error;
                            });
                    })
                    .finally(() => {
                        cancelRequestCtx('rpc-streamer: request ended');
                    });
            } else if (handler.type === 'streamer') {
                let cancelCleanup: Cancel | undefined = undefined;
                const cleanup = (reason: unknown) => {
                    factory.close();
                    cancelCleanup?.(reason);
                };

                cancelCleanup = context().onEnd(reason => {
                    cleanup(reason);
                });

                const parentCtx = context();

                const factory = new AsyncIteratorFactory(writer => {
                    const streamId = createStreamId();
                    const [requestCtx, cancelRequestCtx] =
                        parentCtx.createChild({
                            span: `stream ${name}(${toRequestLog(arg)})`,
                            attributes: {
                                'rpc.streamId': streamId,
                                'rpc.method': name,
                                'rpc.arg': toRequestLog(arg),
                            },
                        });
                    const cancelRequestCtxCleanUp = requestCtx.onEnd(reason => {
                        writer
                            .throw(
                                new CancelledError(
                                    'factory cancel request',
                                    reason
                                )
                            )
                            .finally(() => {
                                writer.end();
                            });
                    });
                    return requestCtx.run(() => {
                        run(async () => {
                            const channel = new Channel();
                            clientApiState.create({
                                streamId,
                                writer: channel,
                                method: name,
                                arg,
                            });

                            log.info('start rpc stream...');
                            await server.stream(
                                {streamId, name, arg},
                                {...headers}
                            );
                            await channel.pipe(writer);
                        }).catch(error => {
                            cleanup(new AppError('run failed', {cause: error}));
                            log.error(error, 'failed to start streaming');
                        });

                        return () => {
                            cancelRequestCtxCleanUp();
                            cancelRequestCtx('stream_has_no_consumers');
                            // we need to run cancellation separately to avoid cancellation of the cancellation
                            context().detach({span: 'cancel stream'}, () => {
                                log.info(
                                    'stream consumer unsubscribed, send cancellation to the server...'
                                );
                                cleanup(new AppError('stream cancelled'));
                                catchConnectionClosed(
                                    server.cancel({
                                        streamId,
                                        reason: 'stream_has_no_consumers',
                                    })
                                )
                                    .then(() => {
                                        log.info('cancelled');
                                    })
                                    .catch(error => {
                                        log.error(
                                            toError(error),
                                            'failed to cancel stream'
                                        );
                                    });
                            });
                        };
                    });
                });

                return toStream(factory);
            } else {
                assertNever(handler);
            }
        };
    }

    return new Proxy<any>({}, {get});
}
