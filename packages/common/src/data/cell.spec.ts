import {describe, expect, it} from 'vitest';
import {InMemoryKeyValueStore} from '../kv/in-memory/in-memory-key-value-store';
import {withPrefix} from '../kv/kv-store';
import {Cell} from './cell';

const initialValue = 42;

describe('Cell', () => {
    it('should return the initial value if no value is set', async () => {
        const store = new InMemoryKeyValueStore();

        await store.transaction(async txn => {
            const cell = new Cell(txn, initialValue);
            const value = await cell.get();
            expect(value).toBe(initialValue);
        });
    });

    it('should store and retrieve a value', async () => {
        const store = new InMemoryKeyValueStore();

        await store.transaction(async txn => {
            const cell = new Cell(txn, initialValue);
            await cell.put(100);
            const value = await cell.get();
            expect(value).toBe(100);
        });
    });

    it('should overwrite the value when put is called again', async () => {
        const store = new InMemoryKeyValueStore();

        await store.transaction(async txn => {
            const cell = new Cell(txn, initialValue);
            await cell.put(100);
            await cell.put(200);
            const value = await cell.get();
            expect(value).toBe(200);
        });
    });

    it('should persist the value across transactions', async () => {
        const store = new InMemoryKeyValueStore();

        await store.transaction(async txn => {
            const cell = new Cell(txn, initialValue);
            await cell.put(300);
        });

        await store.transaction(async txn => {
            const cell = new Cell(txn, initialValue);
            const value = await cell.get();
            expect(value).toBe(300);
        });
    });

    it('should handle multiple cells independently', async () => {
        const store = new InMemoryKeyValueStore();

        await store.transaction(async txn => {
            const cell1 = new Cell(withPrefix('1/')(txn), initialValue);
            const cell2 = new Cell(withPrefix('2/')(txn), 100);
            await cell1.put(400);
            await cell2.put(500);

            const value1 = await cell1.get();
            const value2 = await cell2.get();

            expect(value1).toBe(400);
            expect(value2).toBe(500);
        });
    });

    it('should return undefined if a key is deleted', async () => {
        const store = new InMemoryKeyValueStore();

        await store.transaction(async txn => {
            const cell = new Cell(txn, initialValue);
            await cell.put(600);
            await txn.delete(new Uint8Array());
            const value = await cell.get();
            expect(value).toBe(initialValue);
        });
    });
});
