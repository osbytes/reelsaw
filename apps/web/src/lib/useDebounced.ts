import { useEffect, useState } from "react";

/** `value`, but only after it has stopped changing for `ms` (a search box's query, before it goes to the server). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
