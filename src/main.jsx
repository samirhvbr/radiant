import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import SettingsWindow from './SettingsWindow.jsx'
import Hud from './components/Hud.jsx'
import './styles.css'
import '@xterm/xterm/css/xterm.css'
import 'highlight.js/styles/atom-one-dark.css'

// ⚠️ SET BEFORE THE FIRST PAINT, AND ONLY WHEN WE ARE SURE. The window keeps a
// real title bar everywhere except macOS, and styles.css needs to know so it
// stops reserving 38px for traffic lights and stops arming drag regions for a
// bar the page does not own. Marked only when radiantNative says so: in a plain
// browser there is nothing to be sure about, so nothing changes there.
if (window.radiantNative?.platform && window.radiantNative.platform !== 'darwin') {
  document.documentElement.dataset.windowChrome = 'native'
}

const hash = window.location.hash.replace(/^#/, '')
const [route, tab] = hash.split('/')
createRoot(document.getElementById('root')).render(
  route === 'settings' ? <SettingsWindow initialTab={tab || 'providers'} />
    // The HUD is its own window, so it is its own route — same shape as
    // Settings, and it never mounts the whole app just to draw six rows.
    : route === 'hud' ? <Hud />
      : <App />
)
