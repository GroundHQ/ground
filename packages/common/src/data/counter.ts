import {Uint8Transaction} from '../kv/kv-store';
import {Cell} from './cell';

export class Counter {
    private readonly cell: Cell<number>;

    constructor(txn: Uint8Transaction, initial: number) {
        this.cell = new Cell(txn, initial);
    }

    async get(): Promise<number> {
        return await this.cell.get();
    }

    async increment(delta?: number): Promise<number> {
        const next = (await this.get()) + (delta ?? 1);
        await this.cell.put(next);
        return next;
    }
}