const hasOwn = Object.prototype.hasOwnProperty;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasUnsafePathChar(key: string): boolean {
  return (
    key.indexOf('.') !== -1 ||
    key.indexOf('[') !== -1 ||
    key.indexOf(']') !== -1
  );
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const cleaned = item === undefined ? null : stripUndefined(item);
      if (cleaned !== item && copy === null) {
        copy = value.slice(0, i);
      }
      if (copy !== null) {
        copy.push(cleaned);
      }
    }
    return (copy ?? value) as T;
  }

  if (isPlainObject(value)) {
    let copy: Record<string, unknown> | null = null;
    for (const k in value) {
      if (!hasOwn.call(value, k)) continue;
      const item = value[k];
      if (item === undefined) {
        if (copy === null) {
          copy = {};
          for (const pk in value) {
            if (pk === k) break;
            if (hasOwn.call(value, pk)) copy[pk] = value[pk];
          }
        }
        continue;
      }
      const cleaned = stripUndefined(item);
      if (cleaned !== item && copy === null) {
        copy = {};
        for (const pk in value) {
          if (pk === k) break;
          if (hasOwn.call(value, pk)) copy[pk] = value[pk];
        }
      }
      if (copy !== null) {
        copy[k] = cleaned;
      }
    }
    return (copy ?? value) as T;
  }

  return value;
}

/** Diffs `prev` vs `next` into minimal WeChat `setData` path patches in `out`. */
export function diffSnapshot(
  prev: unknown,
  next: unknown,
  path: string,
  out: Record<string, unknown>
): boolean {
  if (Object.is(prev, next)) {
    return false;
  }

  if (next === undefined) {
    if (prev !== undefined) {
      out[path] = null;
      return true;
    }
    return false;
  }

  if (
    prev === null ||
    next === null ||
    typeof prev !== 'object' ||
    typeof next !== 'object'
  ) {
    out[path] = stripUndefined(next);
    return true;
  }

  const prevIsArr = Array.isArray(prev);
  const nextIsArr = Array.isArray(next);
  if (prevIsArr || nextIsArr) {
    if (!prevIsArr || !nextIsArr || next.length < prev.length) {
      out[path] = stripUndefined(next);
      return true;
    }

    let changed = false;
    for (let i = 0; i < next.length; i++) {
      const nextItem = next[i];
      if (i >= prev.length) {
        out[`${path}[${i}]`] = nextItem === undefined ? null : stripUndefined(nextItem);
        changed = true;
      } else if (!Object.is(prev[i], nextItem)) {
        if (diffSnapshot(prev[i], nextItem, `${path}[${i}]`, out)) {
          changed = true;
        }
      }
    }
    return changed;
  }

  if (!isPlainObject(prev) || !isPlainObject(next)) {
    out[path] = stripUndefined(next);
    return true;
  }

  // Replace parent if a key was deleted (WeChat setData cannot delete keys via dot-paths).
  for (const k in prev) {
    if (!hasOwn.call(prev, k)) continue;
    if (prev[k] !== undefined && (!hasOwn.call(next, k) || next[k] === undefined)) {
      out[path] = stripUndefined(next);
      return true;
    }
  }

  for (const k in next) {
    if (!hasOwn.call(next, k)) continue;
    if (!Object.is(prev[k], next[k]) && hasUnsafePathChar(k)) {
      out[path] = stripUndefined(next);
      return true;
    }
  }

  let changed = false;
  for (const k in next) {
    if (!hasOwn.call(next, k)) continue;
    const nextVal = next[k];
    if (nextVal === undefined) continue;
    const prevVal = prev[k];
    if (Object.is(prevVal, nextVal)) continue;

    const childPath = path ? `${path}.${k}` : k;
    if (!hasOwn.call(prev, k)) {
      out[childPath] = stripUndefined(nextVal);
      changed = true;
    } else if (diffSnapshot(prevVal, nextVal, childPath, out)) {
      changed = true;
    }
  }

  return changed;
}
