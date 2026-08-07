import { describe, it, expect } from 'vitest'
import { AnimationSearch } from './AnimationSearch.ts'
import { ThemeManager } from '../../ThemeManager.ts'
import { SkeletonType } from '../../enums/SkeletonType.ts'

/**
 * Export order prefixes. Positions 0-9 get "N. ", positions from 10 up get
 * "_N. " so the names stay in numeric order when sorted as plain strings —
 * without the underscore "10." falls between "1." and "2.".
 */

// The two methods under test are pure; the surrounding class only needs to exist.
function make_search (): {
  order_prefix: (position: number) => string
  strip_order_prefix: (name: string) => string
} {
  const search = new AnimationSearch('missing-filter', 'missing-list', new ThemeManager(), SkeletonType.Human)
  const any_search = search as unknown as {
    order_prefix: (position: number) => string
    strip_order_prefix: (name: string) => string
  }
  return {
    order_prefix: any_search.order_prefix.bind(search),
    strip_order_prefix: any_search.strip_order_prefix.bind(search)
  }
}

describe('order prefixes', () => {
  it('uses a bare number below 10', () => {
    const { order_prefix } = make_search()
    expect(order_prefix(0)).toBe('0. ')
    expect(order_prefix(8)).toBe('8. ')
    expect(order_prefix(9)).toBe('9. ')
  })

  it('adds a leading underscore from 10 up', () => {
    const { order_prefix } = make_search()
    expect(order_prefix(10)).toBe('_10. ')
    expect(order_prefix(11)).toBe('_11. ')
    expect(order_prefix(120)).toBe('_120. ')
  })

  it('keeps names in numeric order under a plain string sort', () => {
    const { order_prefix } = make_search()
    const base = ['Idle', 'Walk', 'Run', 'Jump', 'Crouch', 'Climb', 'Swim', 'Fall', 'Attack', 'Block',
      'Attack2', 'Sword', 'Death']
    const named = base.map((name, position) => `${order_prefix(position)}${name}`)

    // a naive consumer sorting these as plain strings must still see 0,1,2,...,12
    expect([...named].sort()).toEqual(named)
  })

  it('would be out of order without the underscore', () => {
    // guards the reason the underscore exists
    const naive = Array.from({ length: 13 }, (_, i) => `${i}. Anim`)
    expect([...naive].sort()).not.toEqual(naive)
  })

  it('strips both prefix forms so renumbering does not compound', () => {
    const { strip_order_prefix } = make_search()
    expect(strip_order_prefix('9. Attack')).toBe('Attack')
    expect(strip_order_prefix('_10. Attack')).toBe('Attack')
    expect(strip_order_prefix('_120. Sword Swing')).toBe('Sword Swing')
  })

  it('leaves names without a prefix alone', () => {
    const { strip_order_prefix } = make_search()
    expect(strip_order_prefix('Attack')).toBe('Attack')
    expect(strip_order_prefix('_Attack')).toBe('_Attack')
    expect(strip_order_prefix('Sword 2 Handed')).toBe('Sword 2 Handed')
  })

  it('round-trips: re-numbering a moved item does not stack prefixes', () => {
    const { order_prefix, strip_order_prefix } = make_search()
    const first = `${order_prefix(11)}Attack` // _11. Attack
    const renumbered = `${order_prefix(3)}${strip_order_prefix(first)}`
    expect(renumbered).toBe('3. Attack')

    const back_up = `${order_prefix(10)}${strip_order_prefix(renumbered)}`
    expect(back_up).toBe('_10. Attack')
  })
})

describe('export ordering', () => {
  // mirrors the comparator in StepExportToFile
  const order_key = (name: string): string => name.replace(/^_/, '')
  const sort_for_export = (names: string[]): string[] =>
    [...names].sort((a, b) => order_key(a).localeCompare(order_key(b), undefined, { numeric: true }))

  it('keeps underscore-prefixed names in numeric position', () => {
    const names = ['0. Idle', '1. Walk', '8. Attack', '9. Block', '_10. Sword', '_11. Death', '_12. Fall']
    expect(sort_for_export(names)).toEqual(names)
  })

  it('without stripping the underscore they would float to the front', () => {
    const names = ['0. Idle', '9. Block', '_10. Sword']
    const unfixed = [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    expect(unfixed[0]).toBe('_10. Sword')
  })

  it('still orders zero-padded names correctly', () => {
    const names = ['01_Idle', '02_Walk', '10_Run']
    expect(sort_for_export(names)).toEqual(names)
  })
})
