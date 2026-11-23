// Reads a server-sent-events body in pieces. Events are separated by a blank line; each carries one JSON object on "data:"
// line(s). Lines starting with ":" are keep-alive comments and are ignored. A piece of text can end mid-event, so what is left
// over is held until the rest arrives.
export function createSseParser(onEvent) {
  let buffer = '';
  return {
    feed(text) {
      buffer += text.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let event;
        try { event = JSON.parse(data); } catch { continue; } // one bad event never stops the rest
        onEvent(event);
      }
    },
  };
}
