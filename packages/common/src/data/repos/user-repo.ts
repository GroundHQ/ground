import {Uint8Transaction, withPrefix} from '../../kv/kv-store';
import {Brand} from '../../utils';
import {Uuid, createUuid} from '../../uuid';
import {DocStore, OnDocChange} from '../doc-store';

export type UserId = Brand<Uuid, 'user_id'>;

export function createUserId(): UserId {
    return createUuid() as UserId;
}

export interface User {
    id: UserId;
    name: string;
}

export class UserRepo {
    private readonly store: DocStore<User>;

    constructor(txn: Uint8Transaction, onChange: OnDocChange<User>) {
        this.store = new DocStore<User>({
            txn: withPrefix('d/')(txn),
            onChange,
        });
    }

    getById(id: UserId): Promise<User | undefined> {
        return this.store.getById(id);
    }

    create(user: User): Promise<void> {
        return this.store.create(user);
    }

    update(id: UserId, recipe: (user: User) => User | undefined): Promise<User> {
        return this.store.update(id, recipe);
    }
}
