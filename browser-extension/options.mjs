const status = document.getElementById('status')
document.getElementById('identity').textContent = `Extension ID: ${chrome.runtime.id}`
const show = value => { status.textContent = value.error ?? value.detail ?? (value.ok ? 'Request accepted. Refreshing connection status…' : JSON.stringify(value)) }
async function request(message) { try { show(await chrome.runtime.sendMessage(message)) } catch { show({ error: 'Extension worker unavailable.' }) } }
document.getElementById('disconnect').addEventListener('click', () => { void request({ type: 'disconnect' }) })
void request({ type: 'status' })
