const status = document.getElementById('status')
document.getElementById('identity').textContent = `Extension ID: ${chrome.runtime.id}`
const show = value => { status.textContent = value.error ?? value.detail ?? (value.ok ? 'Request accepted. Refreshing connection status…' : JSON.stringify(value)) }
async function request(message) { try { show(await chrome.runtime.sendMessage(message)) } catch { show({ error: 'Extension worker unavailable.' }) } }
document.getElementById('pair').addEventListener('submit', event => {
  event.preventDefault()
  const input = document.getElementById('token'), token = input.value
  input.value = ''
  void request({ type: 'pair', token })
})
for (const type of ['connect', 'disconnect']) document.getElementById(type).addEventListener('click', () => { void request({ type }) })
void request({ type: 'status' })
