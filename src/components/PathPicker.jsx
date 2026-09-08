import React, { useState } from 'react'

/**
 * Choose a folder (or a file), without typing a path.
 *
 * ⚠️ A BARE TEXT FIELD IS NOT A CHOICE. Both the Graph view and the loop composer
 * shipped asking for an absolute path and nothing else — fine if you already know
 * it, useless otherwise, and there is no reason for it: the Mac has a folder
 * picker and Radiant is already allowed to open one. Tony: "are we expecting
 * users to type in a folder/file path? this is not user friendly at all."
 *
 * ⚠️ THE PICKER OPENS ON THE MAC RUNNING RADIANT, WHICH IS ALSO WHERE THE PATH
 * HAS TO EXIST. That is the same machine, so this is correct — and it is why the
 * browser build cannot have it. A phone on Tailscale is talking to the Mac; a
 * picker there would return a path from the phone. So the field stays, as the
 * fallback rather than as the interface, and it says which machine it means.
 */
export default function PathPicker ({
  value = '', onChange, kind = 'folder', projects = [], placeholder = '/Users/you/Projects/something', label = 'Folder'
}) {
  const native = typeof window !== 'undefined' && window.radiantNative?.pickPath
  const [typing, setTyping] = useState(!native)

  const pick = async k => {
    try {
      const p = await window.radiantNative.pickPath({ current: value || undefined, kind: k })
      if (p) onChange?.(p)
    } catch { setTyping(true) }
  }

  // Somewhere you already work is a better first guess than the file system.
  const quick = projects.filter(p => p.cwd).slice(0, 4)

  return (
    <div className='pp'>
      <div className='pp-row'>
        {native && (
          <>
            <button type='button' className='rx-btn' onClick={() => pick('folder')}>Choose folder</button>
            {kind === 'any' && (
              <button type='button' className='rx-btn' onClick={() => pick('file')}>Choose file</button>
            )}
          </>
        )}
        {(typing || !native) && (
          <input
            className='pp-path'
            value={value}
            onChange={e => onChange?.(e.target.value)}
            placeholder={placeholder}
            aria-label={label}
            spellCheck={false}
          />
        )}
      </div>

      {native && !typing && (
        <div className='pp-chosen'>
          {value
            ? <code className='pp-chosen-path' title={value}>{value}</code>
            : <span className='pp-chosen-none'>Nothing chosen yet.</span>}
          <button type='button' className='pp-link' onClick={() => setTyping(true)}>type it instead</button>
        </div>
      )}
      {native && typing && (
        <div className='pp-chosen'>
          <span className='pp-chosen-none'>A full path on this Mac.</span>
          <button type='button' className='pp-link' onClick={() => setTyping(false)}>use the picker</button>
        </div>
      )}
      {!native && (
        <div className='pp-chosen'>
          <span className='pp-chosen-none'>A full path on the Mac running Radiant — not on this device.</span>
        </div>
      )}

      {quick.length > 0 && (
        <div className='pp-quick'>
          <span className='pp-quick-lead'>Your projects</span>
          {quick.map(p => (
            <button
              key={p.id}
              type='button'
              className={'pp-chip' + (value === p.cwd ? ' on' : '')}
              title={p.cwd}
              onClick={() => onChange?.(p.cwd)}
            >{p.name}</button>
          ))}
        </div>
      )}
    </div>
  )
}
