// The popup: is Scenecast there, and what the recorder is doing (it's driven by the Scenecast app). Nothing to set:
// the extension finds the app's receiver by itself.
const $ = id => document.getElementById(id);
async function refresh() {
  const s = await chrome.runtime.sendMessage({ op: 'status' });
  $('dot').className = 'dot' + (s.connected ? ' on' : '');
  $('conn').textContent = s.connected ? 'Connected to Scenecast' : 'Looking for Scenecast… Open the Scenecast app and a demo\'s Record step.';
  $('port').textContent = s.connected ? `on port ${(s.receiver || '').split(':').pop()}` : '';
  const r = s.status || {};
  $('rec').textContent = r.recording ? `Recording: ${r.count} screens, ${r.busy ? 'capturing side states, wait…' : 'ready for the next step'}` : 'Not recording';
  $('ver').textContent = 'Version ' + chrome.runtime.getManifest().version;
  $('log').hidden = !(r.log || []).length;
  $('log').textContent = (r.log || []).join('\n');
}
refresh(); setInterval(refresh, 1500);
