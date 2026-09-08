import React from 'react'

/**
 * What a loop is, drawn.
 *
 * Adapted from Dhairya Karekar's "4 Layers of an Agent System" (the Loop panel),
 * which is where this feature came from. That poster is five colours of neon on
 * black; this is the same idea in the app's own palette, because a reference
 * card that fights the theme it sits in gets read once and then ignored.
 *
 * ⚠️ ONE HONEST DIFFERENCE, AND IT IS ON THE CARD. The original says verify with
 * an EXTERNAL signal — tests, build exit code — "not the model". Radiant's check
 * runs as a turn, so a model reads the verdict. What makes that worth anything is
 * the check you write: "npm test exits 0" sends it to run the tests, and "the code
 * is clean" asks it for an opinion. The Verify note says so rather than quietly
 * claiming a guarantee this does not have.
 *
 * Inline SVG rather than an image: it inherits currentColor, so it is correct in
 * light, medium and dark without three exports, and it stays sharp.
 */
export default function LoopDiagram () {
  return (
    <figure className='lp-fig'>
      {/* ⚠️ THE viewBox IS CROPPED TO THE DRAWING, not to a round number. At
          0 0 560 190 a third of the box was empty margin, so fitting it in the
          panel scaled the whole thing down and the labels rendered at nine
          pixels. min-x and min-y trim the dead space without moving a single
          coordinate. */}
      <svg className='lp-fig-svg' viewBox='118 -8 344 176' role='img'
        aria-label='A loop: observe, act, verify — repeating until the check passes.'>
        <defs>
          {/* ⚠️ THE ARROWHEAD HAS TO CLEAR THE NODE IT POINTS AT. The first version
              ran each arc from one node centre to the next, so every head landed
              underneath a filled 15px circle and the loop drew as a plain ring
              with no direction at all — the one thing the picture exists to say.
              The arcs now stop 24° short at both ends. */}
          <marker id='lp-arrow' viewBox='0 0 10 10' refX='9' refY='5'
            markerWidth='4.5' markerHeight='4.5' orient='auto'>
            <path d='M 0 0 L 10 5 L 0 10 z' fill='currentColor' />
          </marker>
        </defs>

        <text className='lp-fig-side' x='188' y='90' textAnchor='end'>one turn</text>
        <text className='lp-fig-side' x='188' y='106' textAnchor='end'>of the agent</text>

        {/* Three stops on one ring. It is not a line with a check bolted on the end. */}
        <path className='lp-fig-arc' d='M 303.6 42 A 58 58 0 0 1 337.7 101.1' markerEnd='url(#lp-arrow)' />
        <path className='lp-fig-arc' d='M 314.1 141.9 A 58 58 0 0 1 245.9 141.9' markerEnd='url(#lp-arrow)' />
        <path className='lp-fig-arc' d='M 222.3 101.1 A 58 58 0 0 1 256.4 42' markerEnd='url(#lp-arrow)' />

        {/* The centre glyph carries "again", which is the part of a loop that a
            ring of three boxes does not say on its own. */}
        <g className='lp-fig-again'>
          <path d='M 291 88 A 13 13 0 1 1 285.5 82.6' markerEnd='url(#lp-arrow)' />
        </g>

        <g className='lp-fig-node'>
          <circle cx='280' cy='37' r='15' />
          <path className='lp-fig-icon' d='M 272 37 q 8 -7.5 16 0 q -8 7.5 -16 0 z' />
          <circle className='lp-fig-icon-dot' cx='280' cy='37' r='2.4' />
        </g>
        <text className='lp-fig-label' x='280' y='13' textAnchor='middle'>Observe</text>

        <g className='lp-fig-node'>
          <circle cx='330.2' cy='124' r='15' />
          <path className='lp-fig-icon' d='M 333 117 l -6.5 8.5 h 4.2 l -2 6.5 l 6.5 -8.5 h -4.2 z' />
        </g>
        <text className='lp-fig-label' x='352' y='128'>Act</text>

        <g className='lp-fig-node'>
          <circle cx='229.8' cy='124' r='15' />
          <path className='lp-fig-icon' d='M 224 124 l 4 4.2 l 8 -8.4' fill='none' />
        </g>
        <text className='lp-fig-label' x='208' y='128' textAnchor='end'>Verify</text>

        <text className='lp-fig-side' x='372' y='90'>repeat until</text>
        <text className='lp-fig-side' x='372' y='106'>the check passes</text>
      </svg>

      <figcaption className='lp-fig-notes'>
        <div>
          <b>Act</b>
          <span>Do the step. One goal, in one folder, in one conversation you can watch.</span>
        </div>
        <div>
          <b>Observe</b>
          <span>Read what actually happened — what the tests printed, what is on disk — not what was expected.</span>
        </div>
        <div>
          <b>Verify</b>
          <span>A separate turn judges the step against your condition. Point it at something checkable —
            a command that exits 0, a file that exists — because "it looks right" is an opinion, and an
            opinion is what a loop exists to replace.</span>
        </div>
        <div>
          <b>Stop rule</b>
          <span>A goal, not a step count. The loop ends when the check passes, or when the step runs out
            of the attempts you allowed it.</span>
        </div>
      </figcaption>
    </figure>
  )
}
