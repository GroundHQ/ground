import {decode, encode} from 'bytewise';
import {Serializer} from '../serializer';
import {compareUint8Array} from '../utils';
import {Uuid, UuidSerializer} from '../uuid';

const uuidSerializer = new UuidSerializer();
export type IndexKeyPart = number | boolean | string | Uuid | Uint8Array | null | undefined;

export type IndexKey = readonly IndexKeyPart[];

export function compareIndexKeyPart(a: IndexKeyPart, b: IndexKeyPart): 1 | 0 | -1 {
    if (a === null && b === null) return 0;
    if (a === null) return -1;
    if (b === null) return 1;

    if (typeof a === 'boolean' && typeof b === 'boolean') {
        return a === b ? 0 : a ? 1 : -1;
    }

    if (typeof a === 'number' && typeof b === 'number') {
        return a === b ? 0 : a > b ? 1 : -1;
    }

    if (typeof a === 'string' && typeof b === 'string') {
        return a === b ? 0 : a > b ? 1 : -1;
    }

    if (a instanceof Uuid && b instanceof Uuid) {
        return a.compare(b);
    }

    if (a instanceof Uint8Array && b instanceof Uint8Array) {
        return compareUint8Array(a, b);
    }

    const typeOrder = ['null', 'boolean', 'number', 'Uuid', 'Uint8Array', 'string', 'undefined'];
    const getTypeIndex = (val: IndexKeyPart): number =>
        val === null
            ? typeOrder.indexOf('null')
            : val instanceof Uuid
              ? typeOrder.indexOf('Uuid')
              : val instanceof Uint8Array
                ? typeOrder.indexOf('Uint8Array')
                : typeOrder.indexOf(typeof val);

    return getTypeIndex(a) > getTypeIndex(b) ? 1 : -1;
}

export class KeySerializer implements Serializer<IndexKey, Uint8Array> {
    encode(data: IndexKey): Uint8Array {
        const key = data.map(part => {
            if (part instanceof Uuid) {
                return [1, Buffer.from(uuidSerializer.encode(part))];
            } else {
                return part;
            }
        });
        return new Uint8Array(encode(key));
    }

    decode(encoding: Uint8Array): IndexKey {
        const key = decode(Buffer.from(encoding));

        return key.map(part => {
            if (Array.isArray(part)) {
                return uuidSerializer.decode(part[1]);
            } else {
                return part;
            }
        });
    }
}
