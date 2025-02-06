import {z, ZodType} from 'zod';
import {BigFloat, zBigFloat} from '../../big-float.js';
import {CrdtDiff} from '../../crdt/crdt.js';
import {Uint8Transaction, withPrefix} from '../../kv/kv-store.js';
import {Stream} from '../../stream.js';
import {Brand} from '../../utils.js';
import {createUuid, Uuid, zUuid} from '../../uuid.js';
import {Doc, DocRepo, OnDocChange, Recipe, zDoc} from '../doc-repo.js';
import {BoardId, BoardRepo} from './board-repo.js';
import {CategoryId} from './category-repo.js';
import {UserId, UserRepo} from './user-repo.js';

export type TaskId = Brand<Uuid, 'task_id'>;

export function createTaskId(): TaskId {
    return createUuid() as TaskId;
}

export interface Task extends Doc<[TaskId]> {
    readonly id: TaskId;
    readonly authorId: UserId;
    readonly boardId: BoardId;
    readonly counter: number;
    title: string;
    deleted: boolean;
    categoryPosition: BigFloat;
    categoryId: CategoryId | null;
}

const BOARD_ID_COUNTER_INDEX = 'boardId_counter';

// todo: tests should handle get by board_id with counter = undefined to check that BOARD_ID_COUNTER_INDEX is not used (it excludes counter === undefined)

export function zTask(): ZodType<Task> {
    return zDoc(z.tuple([zUuid<TaskId>()])).extend({
        id: zUuid<TaskId>(),
        authorId: zUuid<UserId>(),
        boardId: zUuid<BoardId>(),
        counter: z.number(),
        title: z.string(),
        deleted: z.boolean(),
        categoryPosition: zBigFloat(),
        categoryId: zUuid<CategoryId>().nullable(),
    });
}

export class TaskRepo {
    public readonly rawRepo: DocRepo<Task>;

    constructor(
        tx: Uint8Transaction,
        boardRepo: BoardRepo,
        userRepo: UserRepo,
        onChange: OnDocChange<Task>
    ) {
        this.rawRepo = new DocRepo<Task>({
            tx: withPrefix('d/')(tx),
            onChange,
            indexes: {
                [BOARD_ID_COUNTER_INDEX]: {
                    key: x => [x.boardId, x.counter],
                    unique: true,
                },
            },
            schema: zTask(),
            constraints: [
                {
                    name: 'task.authorId fk',
                    verify: async task => {
                        const user = await userRepo.getById(task.authorId);
                        return user !== undefined;
                    },
                },
                {
                    name: 'task.boardId fk',
                    verify: async task => {
                        const board = await boardRepo.getById(task.boardId);
                        return board !== undefined;
                    },
                },
            ],
            readonly: {
                boardId: true,
                counter: true,
                id: true,
                deleted: false,
                title: false,
                authorId: true,
                categoryPosition: false,
                categoryId: false,
            },
        });
    }

    getById(id: TaskId): Promise<Task | undefined> {
        return this.rawRepo.getById([id]);
    }

    getByBoardId(boardId: BoardId): Stream<Task> {
        return this.rawRepo.get(BOARD_ID_COUNTER_INDEX, [boardId]);
    }

    async apply(id: Uuid, diff: CrdtDiff<Task>): Promise<void> {
        return await this.rawRepo.apply([id], diff);
    }

    create(user: Omit<Task, 'pk'>): Promise<Task> {
        return this.rawRepo.create({pk: [user.id], ...user});
    }

    update(id: TaskId, recipe: Recipe<Task>): Promise<Task> {
        return this.rawRepo.update([id], recipe);
    }
}
