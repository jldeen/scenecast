// The popup: is the receiver there, which port, and what the recorder is doing (it's driven by scenecast).
const $ = id => document.getElementById(id);
async function refresh() {
  const s = await chrome.runtime.sendMessage({ op: 'status' });
  $('port').value = (s.receiver || '').split(':').pop();
  $('dot').className = 'dot' + (s.connected ? ' on' : '');
  $('conn').textContent = s.connected ? 'Connected to scenecast' : 'Not connected: run scenecast receiver (or record) on this machine';
  const r = s.status || {};
  $('rec').textContent = r.recording ? `Recording: ${r.count} screens, ${r.busy ? 'capturing side states, wait…' : 'ready for the next step'}` : 'Not recording';
  $('log').hidden = !(r.log || []).length;
  $('log').textContent = (r.log || []).join('\n');
}
$('save').onclick = async () => { await chrome.runtime.sendMessage({ op: 'port', port: $('port').value }); refresh(); };
refresh(); setInterval(refresh, 1500);
