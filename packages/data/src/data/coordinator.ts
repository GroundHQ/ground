import {z} from 'zod';
import {Uint8KVStore} from '../kv/kv-store.js';
import {addHours, getNow} from '../timestamp.js';
import {arrayEqual, whenAll} from '../utils.js';
import {zUuid} from '../uuid.js';
import {Actor, DataAccessor} from './actor.js';
import {AuthContext, AuthContextParser} from './auth-context.js';
import {Message} from './communication/message.js';
import {createApi, handler, setupRpcServer} from './communication/rpc.js';
import {Connection, TransportServer} from './communication/transport.js';
import {DataLayer, TransactionContext} from './data-layer.js';
import {CryptoService, EmailService, JwtService} from './infra.js';
import {BoardId} from './repos/board-repo.js';
import {Identity, VerificationCode, createIdentityId} from './repos/identity-repo.js';
import {TaskId} from './repos/task-repo.js';
import {UserId, createUserId} from './repos/user-repo.js';

export class Coordinator {
    private readonly dataLayer: DataLayer;

    constructor(
        private readonly transport: TransportServer<Message>,
        kv: Uint8KVStore,
        private readonly jwt: JwtService,
        private readonly crypto: CryptoService,
        private readonly email: EmailService,
        jwtSecret: string
    ) {
        this.dataLayer = new DataLayer(kv, jwtSecret);
    }

    async launch(): Promise<void> {
        await this.transport.launch(conn => this.handleConnection(conn));
    }

    close() {
        this.transport.close();
    }

    private handleConnection(conn: Connection<Message>): void {
        const authContextParser = new AuthContextParser(4, this.jwt);
        setupRpcServer(conn, createCoordinatorApi, async (message, fn) => {
            let effects: Array<() => Promise<void>> = [];
            const result = await this.dataLayer.transaction(async ctx => {
                effects = [];
                const auth = authContextParser.parse(ctx, message.headers?.auth);
                return await fn({
                    ctx,
                    auth,
                    jwt: this.jwt,
                    crypto: this.crypto,
                    emailService: this.email,
                    enqueueEffect: effect => effects.push(effect),
                });
            });
            await whenAll(effects.map(effect => effect()));
            return result;
        });
    }
}

export interface BaseVerifySignInCodeResponse<TType extends string> {
    readonly type: TType;
}

export interface SuccessVerifySignInCodeResponse extends BaseVerifySignInCodeResponse<'success'> {
    readonly token: string;
}

export interface InvalidCodeVerifySignInCodeResponse extends BaseVerifySignInCodeResponse<'invalid_code'> {}

export interface CodeExpiredVerifySignInCodeResponse extends BaseVerifySignInCodeResponse<'code_expired'> {}

export type VerifySignInCodeResponse =
    | SuccessVerifySignInCodeResponse
    | InvalidCodeVerifySignInCodeResponse
    | CodeExpiredVerifySignInCodeResponse;

function createCoordinatorApi({
    ctx,
    auth,
    jwt,
    crypto,
    emailService,
    enqueueEffect,
}: {
    ctx: TransactionContext;
    auth: AuthContext;
    jwt: JwtService;
    crypto: CryptoService;
    emailService: EmailService;
    enqueueEffect: (cb: () => Promise<void>) => void;
}) {
    const actor: Actor = new Actor(ctx.txn, auth, {type: 'coordinator'});

    const dbApi = createApi({
        getMe: handler({
            schema: z.object({}),
            handle: actor.getMe.bind(actor),
        }),
        getMyBoards: handler({
            schema: z.object({}),
            handle: actor.getMyBoards.bind(actor),
        }),
        getBoardTasks: handler({
            schema: z.object({boardId: zUuid<BoardId>()}),
            handle: actor.getBoardTasks.bind(actor),
        }),
        getTask: handler({
            schema: z.object({taskId: zUuid<TaskId>()}),
            handle: actor.getTask.bind(actor),
        }),
        createTask: handler({
            schema: z.object({
                taskId: zUuid<TaskId>(),
                boardId: zUuid<BoardId>(),
                title: z.string(),
            }),
            handle: actor.createTask.bind(actor),
        }),
        createBoard: handler({
            schema: z.object({
                boardId: zUuid<BoardId>(),
                name: z.string(),
                slug: z.string().optional(),
            }),
            handle: actor.createBoard.bind(actor),
        }),
        getBoard: handler({
            schema: z.object({
                boardId: zUuid<BoardId>(),
            }),
            handle: actor.getBoard.bind(actor),
        }),
        setBoardSlug: handler({
            schema: z.object({
                boardId: zUuid<BoardId>(),
                slug: z.string(),
            }),
            handle: actor.setBoardSlug.bind(actor),
        }),
        updateBoardName: handler({
            schema: z.object({
                boardId: zUuid<BoardId>(),
                name: z.string(),
            }),
            handle: actor.updateBoardName.bind(actor),
        }),
        updateTaskTitle: handler({
            schema: z.object({
                taskId: zUuid<TaskId>(),
                title: z.string(),
            }),
            handle: actor.updateTaskTitle.bind(actor),
        }),
    } satisfies DataAccessor);

    const authApi = createApi({
        debug: handler({
            schema: z.object({}),
            handle: async () => {
                const identities = ctx.identities.getByEmail('tilyupo@gmail.com');
                return identities;
            },
        }),
        sendSignInEmail: handler({
            schema: z.object({
                email: z.string(),
            }),
            handle: async ({email}): Promise<{}> => {
                const buf = await crypto.randomBytes(6);
                const verificationCode: VerificationCode = {
                    code: Array.from(buf).map(x => x % 10),
                    // verification token expires after one hour
                    expires: addHours(getNow(), 1),
                };

                const identity = await ctx.identities.getByEmail(email);
                if (identity) {
                    await ctx.identities.update(identity.id, x => {
                        x.verificationCode = verificationCode;
                    });
                } else {
                    const now = getNow();
                    const userId = createUserId();
                    await whenAll([
                        ctx.users.create({
                            id: userId,
                            createdAt: now,
                            updatedAt: now,
                        }),
                        ctx.identities.create({
                            id: createIdentityId(),
                            createdAt: now,
                            updatedAt: now,
                            email,
                            userId,
                            verificationCode,
                        }),
                    ]);
                }

                enqueueEffect(async () => {
                    await emailService.send(
                        email,
                        `Hi,
There was a request to sign into your Ground account!

If you did not make this request then please ignore this email.

Your one-time code is: ${verificationCode.code.join('')}`
                    );
                });

                return {};
            },
        }),
        verifySignInCode: handler({
            schema: z.object({
                email: z.string(),
                code: z.array(z.number()),
            }),
            handle: async ({email, code}): Promise<VerifySignInCodeResponse> => {
                const identity = await ctx.identities.getByEmail(email);
                if (!identity) {
                    throw new Error('invalid email, no identity found');
                }

                console.log({code, verificationCode: identity.verificationCode});

                if (identity.verificationCode === undefined) {
                    throw new Error('verification code was not requested');
                }

                if (getNow() > identity.verificationCode.expires) {
                    return {type: 'code_expired'};
                }

                if (!arrayEqual(code, identity.verificationCode.code)) {
                    return {type: 'invalid_code'};
                }

                return {
                    type: 'success',
                    token: createToken(jwt, identity, ctx.config.jwtSecret),
                };
            },
        }),
    });

    return {
        ...dbApi,
        ...authApi,
    };
}

interface JwtPayload {
    sub: string;
    exp: number;
    user_id: UserId;
}

function createToken(jwt: JwtService, identity: Identity, jwtSecret: string) {
    const exp = new Date();
    exp.setFullYear(exp.getFullYear() + 50);

    return jwt.sign(
        {
            sub: identity.id.toString(),
            exp: Math.trunc(exp.getTime() / 1000),
            user_id: identity.userId,
        } satisfies JwtPayload,
        jwtSecret
    );
}

export type CoordinatorApi = ReturnType<typeof createCoordinatorApi>;
