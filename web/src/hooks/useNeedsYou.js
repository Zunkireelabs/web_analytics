import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { pickItemsToRaise, rememberRaised, loadMemory, saveMemory } from '../lib/needs-you-followup.js';

const RECHECK_MS = 5 * 60 * 1000;

// What is waiting on the person for this project, and which of it to bring up now. `raise` is the list the assistant
// should open with (empty when nothing is due), so the chat opens by itself only for something new or due again.
// Checked on load and every 5 minutes. `ack()` records that the raise was shown, so it is not repeated at once.
export default function useNeedsYou(siteId, { enabled = true } = {}) {
  const [items, setItems] = useState([]);
  const [raise, setRaise] = useState([]);
  const itemsRef = useRef([]);

  const check = useCallback(() => {
    if (!siteId) return;
    api.assistant.invoke('get_needs_you').then((res) => {
      const list = res?.ok ? res.data.items : [];
      itemsRef.current = list;
      setItems(list);
      setRaise(pickItemsToRaise(list, loadMemory(siteId)));
    }).catch(() => {});
  }, [siteId]);

  useEffect(() => {
    setItems([]); setRaise([]);
    if (!enabled || !siteId) return undefined;
    check();
    const t = setInterval(check, RECHECK_MS);
    return () => clearInterval(t);
  }, [siteId, enabled, check]);

  const ack = useCallback((shown) => {
    if (!shown?.length) return;
    saveMemory(siteId, rememberRaised(itemsRef.current, shown, loadMemory(siteId)));
    setRaise([]);
  }, [siteId]);

  return { items, raise, ack, recheck: check };
}
