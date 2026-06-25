// Shared lobby + game chat. Loaded as a plain <script> before the page logic;
// exposes window.MahjongChat. Chat text is rendered via textContent (no innerHTML),
// so chat messages can't inject markup.
(function (global) {
  const EMOJIS = ['👍','😂','🎉','😮','😢','🔥','👏','🤔','🙏','🀄'];
  const ACTION_LABELS = { pong: 'Pong 碰', kong: 'Kong 槓', chow: 'Chow 上' };
  const $ = id => document.getElementById(id);

  // initChat(socket, opts):
  //   opts.glyph(tile) -> string  — render action meld tiles (game board passes tileGlyph; lobby omits)
  //   opts.onAction(entry)        — extra handling for a live action (game board shows a seat bubble)
  function initChat(socket, opts = {}) {
    const log = $('chat-log');
    const bar = $('emoji-bar');
    const input = $('chat-input');
    const sendBtn = $('chat-send');
    if (!log || !bar || !input || !sendBtn) return; // page has no chat UI

    function lineEl(entry) {
      const div = document.createElement('div');
      if (entry.kind === 'action') {
        div.className = 'chat-msg chat-action';
        const tiles = opts.glyph ? ' ' + (entry.tiles || []).map(opts.glyph).join('') : '';
        div.textContent = `${entry.name}: ${ACTION_LABELS[entry.type] || entry.type}${tiles}`;
      } else {
        div.className = 'chat-msg';
        const nm = document.createElement('span');
        nm.className = 'chat-name';
        nm.textContent = entry.name + ': ';
        const tx = document.createElement('span');
        tx.textContent = entry.text; // textContent → no HTML injection from chat
        div.append(nm, tx);
      }
      return div;
    }
    function append(entry) { log.appendChild(lineEl(entry)); log.scrollTop = log.scrollHeight; }
    function send() { if (input.value.trim()) socket.emit('chat', { text: input.value }); input.value = ''; }

    EMOJIS.forEach(e => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emoji-btn';
      b.textContent = e;
      b.addEventListener('click', () => socket.emit('chat', { text: e }));
      bar.appendChild(b);
    });
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });

    const widget = $('chat-widget'), toggle = $('chat-toggle');
    if (widget && toggle) toggle.addEventListener('click', () => widget.classList.toggle('collapsed'));

    socket.on('chatHistory', msgs => { log.innerHTML = ''; (msgs || []).forEach(append); });
    socket.on('chatMessage', append);
    socket.on('playerAction', entry => { append(entry); if (opts.onAction) opts.onAction(entry); });
  }

  global.MahjongChat = { initChat, ACTION_LABELS };
})(window);
