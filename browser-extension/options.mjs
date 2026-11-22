import { en } from './locales.mjs'

for (const element of document.querySelectorAll('[data-message]')) element.textContent = en[element.dataset.message]
const status = document.getElementById('status')
document.getElementById('identity').textContent = en.identity.replace('{id}', chrome.runtime.id)
const show = value => { status.textContent = value.error ?? value.detail ?? (value.ok ? en.accepted : JSON.stringify(value)) }
async function request(message) { try { show(await chrome.runtime.sendMessage(message)) } catch { show({ error: en.unavailable }) } }
document.getElementById('disconnect').addEventListener('click', () => { void request({ type: 'disconnect' }) })
void request({ type: 'status' })
