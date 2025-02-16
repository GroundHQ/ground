import {type Codec, NumberCodec} from '../codec.js';
import {Stream, toStream} from '../stream.js';
import {pipe, whenAll} from '../utils.js';
import {Counter} from './counter.js';
import {
    type Transaction,
    type Uint8Transaction,
    withKeyCodec,
    withPrefix,
    withValueCodec,
} from './kv-store.js';

export interface CollectionEntry<T> {
    readonly offset: number;
    readonly data: T;
}

export class Collection<T> {
    private readonly counter: Counter;
    private readonly log: Transaction<number, T>;

    constructor(tx: Uint8Transaction, codec: Codec<T>) {
        this.counter = new Counter(pipe(tx, withPrefix('i/')), 0);
        this.log = pipe(
            tx,
            withPrefix('l/'),
            withKeyCodec(new NumberCodec()),
            withValueCodec(codec)
        );
    }

    async length() {
        return await this.counter.get();
    }

    async append(...data: T[]): Promise<void> {
        const offset =
            (await this.counter.increment(data.length)) - data.length;
        await whenAll(data.map((x, idx) => this.log.put(offset + idx, x)));
    }

    list(start: number, end?: number): Stream<CollectionEntry<T>> {
        return toStream(this._list(start, end));
    }

    private async *_list(
        start: number,
        end?: number
    ): AsyncIterable<CollectionEntry<T>> {
        for await (const {key, value} of this.log.query({gte: start})) {
            if (end !== undefined && key >= end) return;

            yield {offset: key, data: value};
        }
    }
}
