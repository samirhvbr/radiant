import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, saveToFile } from '../api.js'
import { renderMermaid } from './Markdown.jsx'

/**
 * Point Radiant at a folder; get a picture of it.
 *
 * ⚠️ NOTHING ON THIS SCREEN WAS WRITTEN BY A MODEL. Every box is a folder that
 * exists and every arrow is an import statement that resolves to a file on disk
 * — see server/graph.js. A model asked to draw an architecture produces
 * something plausible, and a diagram you have to check by hand is worse than no
 * diagram, because it gets believed. The model is available afterwards, to
 * explain what was drawn; it never gets to draw it.
 */

const LEVELS = [
  { id: 'folder', label: 'Folders', hint: 'The shape of the project' },
  { id: 'file', label: 'Files', hint: 'Every file and what it imports' }
]

export default function GraphView ({ defaultPath = '', mode = 'dark', onExplain, onError }) {
  const [path, setPath] = useState(defaultPath)
  const [level, setLevel] = useState('folder')
  const [graph, setGraph] = useState(null)
  const [busy, setBusy] = useState(false)
  const [drawError, setDrawError] = useState(null)
  const host = useRef(null)
  // ⚠️ STATE, NOT A REF. Writing the finished SVG to a ref does not re-render,
  // so "Save SVG" stayed disabled after a diagram had visibly drawn — the value
  // was there and nothing asked the button again.
  const [svg, setSvg] = useState('')

  useEffect(() => { setPath(p => p || defaultPath) }, [defaultPath])

  const scan = useCallback(async (nextLevel) => {
    const p = path.trim()
    if (!p) return
    setBusy(true); setDrawError(null)
    try {
      const g = await api.scanGraph(p, nextLevel || level)
      setGraph(g)
    } catch (e) { setGraph(null); setDrawError(e.message); onError?.(e.message) } finally { setBusy(false) }
  }, [path, level, onError])

  // ⚠️ DRAWING IS ASYNC AND THE ANSWER CAN ARRIVE FOR A GRAPH YOU HAVE LEFT.
  // mermaid.render is a dynamic import on first use and a parse after that, so
  // switching from Folders to Files while the first is still rendering used to
  // paint the old diagram over the new one.
  useEffect(() => {
    if (!graph || !host.current) return
    let stale = false
    const el = host.current
    el.innerHTML = ''
    setSvg('')
    // The same signal Markdown and the terminal read — light is the only mode
    // that is light; 'medium' is a dark page and needs mermaid's dark theme.
    // `mode` stays in the deps so switching theme redraws.
    renderMermaid(graph.mermaid, el, document.documentElement.dataset.mode !== 'light')
      .then(out => { if (stale) el.innerHTML = ''; else setSvg(out) })
      .catch(e => { if (!stale) { el.innerHTML = ''; setDrawError('That diagram could not be drawn: ' + e.message) } })
    return () => { stale = true }
  }, [graph, mode])

  const loose = graph ? graph.nodes.filter(n => n.degree === 0) : []

  const explain = () => {
    if (!graph) return
    // Everything the model needs is in the message, so it is explaining a real
    // scan rather than going and forming its own opinion of the repo.
    onExplain?.([
      `Here is a map of ${graph.root}, produced by reading the imports in ${graph.stats.files} source files.`,
      'Explain what this project is and how it is put together, in plain language. Point out anything that looks like a problem — a folder everything depends on, a cycle, a layer that reaches past the one below it. Do not restate the diagram.',
      '```mermaid\n' + graph.mermaid + '\n```',
      graph.stats.externals.length
        ? 'Most used dependencies: ' + graph.stats.externals.slice(0, 10).map(x => `${x.name} (${x.count})`).join(', ')
        : ''
    ].filter(Boolean).join('\n\n'))
  }

  return (
    <section className='gv' aria-label='Graph'>
      <header className='gv-head'>
        <h2 className='gv-title'>Graph</h2>
        <form className='gv-point' onSubmit={e => { e.preventDefault(); scan() }}>
          <input
            className='gv-path'
            value={path}
            onChange={e => setPath(e.target.value)}
            placeholder='/Users/you/Projects/something'
            aria-label='Folder to draw'
            spellCheck={false}
          />
          <button className='gv-draw' type='submit' disabled={busy || !path.trim()}>
            {busy ? 'Reading…' : 'Draw it'}
          </button>
        </form>
      </header>

      <div className='gv-levels' role='group' aria-label='Level of detail'>
        {LEVELS.map(l => (
          <button
            key={l.id}
            className={'gv-level' + (level === l.id ? ' on' : '')}
            title={l.hint}
            onClick={() => { setLevel(l.id); if (graph) scan(l.id) }}
          >{l.label}</button>
        ))}
      </div>

      {drawError && <p className='gv-error'>{drawError}</p>}

      {!graph && !busy && !drawError && (
        <div className='gv-blank'>
          <p className='gv-blank-lead'>Point Radiant at a folder.</p>
          <p className='gv-blank-sub'>
            It reads the imports in every source file and draws what actually
            depends on what. Nothing here is guessed: a box is a folder that
            exists, an arrow is an import that resolves to a file on disk.
          </p>
        </div>
      )}

      {graph && (
        <div className='gv-body'>
          <div className='gv-canvas'>
            <div className='gv-mermaid' ref={host} />
          </div>

          <aside className='gv-side'>
            <div className='gv-stat-row'>
              <div className='gv-stat'><b>{graph.stats.files}</b><span>files read</span></div>
              <div className='gv-stat'><b>{graph.stats.units}</b><span>{graph.level === 'file' ? 'files' : 'folders'}</span></div>
              <div className='gv-stat'><b>{graph.stats.imports}</b><span>imports</span></div>
            </div>

            {/* Say what was left out, rather than quietly drawing less. */}
            {graph.stats.drawn < graph.stats.units && (
              <p className='gv-note'>
                Showing the {graph.stats.drawn} most connected of {graph.stats.units}.
              </p>
            )}
            {graph.stats.skipped > 0 && (
              <p className='gv-note'>
                {graph.stats.skipped} built or minified file{graph.stats.skipped === 1 ? ' was' : 's were'} skipped —
                a bundled copy of the app is not part of it.
              </p>
            )}
            {graph.stats.truncated && (
              <p className='gv-note gv-warn'>That folder is larger than one drawing can hold; this is the first part of it.</p>
            )}

            {loose.length > 0 && (
              <div className='gv-block'>
                <h3 className='gv-block-title'>Nothing imports these</h3>
                <p className='gv-note'>They are in the project but no arrow reaches them, so they are listed instead of drawn.</p>
                <ul className='gv-list'>
                  {loose.slice(0, 12).map(n => (
                    <li key={n.id}><code>{n.label}</code> <span className='gv-dim'>{n.files}</span></li>
                  ))}
                  {loose.length > 12 && <li className='gv-dim'>and {loose.length - 12} more</li>}
                </ul>
              </div>
            )}

            {graph.stats.languages.length > 0 && (
              <div className='gv-block'>
                <h3 className='gv-block-title'>Written in</h3>
                <ul className='gv-list'>
                  {graph.stats.languages.map(l => (
                    <li key={l.lang}><code>{l.lang}</code> <span className='gv-dim'>{l.count}</span></li>
                  ))}
                </ul>
              </div>
            )}

            {graph.stats.externals.length > 0 && (
              <div className='gv-block'>
                <h3 className='gv-block-title'>Leans on</h3>
                <ul className='gv-list'>
                  {graph.stats.externals.slice(0, 10).map(x => (
                    <li key={x.name}><code>{x.name}</code> <span className='gv-dim'>{x.count}</span></li>
                  ))}
                </ul>
              </div>
            )}

            <div className='gv-acts'>
              <button className='gv-act' onClick={explain} disabled={!onExplain}>Explain this</button>
              <button
                className='gv-act'
                onClick={() => saveToFile(`${graph.name || 'graph'}.svg`, 'image/svg+xml', svg)}
                disabled={!svg}
              >Save SVG</button>
              <button className='gv-act' onClick={() => scan()} disabled={busy}>Read it again</button>
            </div>
          </aside>
        </div>
      )}
    </section>
  )
}
