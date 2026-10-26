import { describe, expect, it } from 'vitest'
import { jsonObject, jsonValue, stringList, validateSceneTimeout } from '../src/db-values.js'

describe('database value decoding', () => {
  it('accepts only strings from persisted string arrays', () => {
    expect(stringList('["one",2,null,"two"]')).toEqual(['one', 'two'])
    expect(stringList('{"not":"an array"}')).toEqual([])
    expect(stringList('invalid json')).toEqual([])
  })

  it('accepts only plain JSON objects', () => {
    expect(jsonObject('{"enabled":true}')).toEqual({ enabled: true })
    expect(jsonObject('["not an object"]')).toEqual({})
    expect(jsonObject('null')).toEqual({})
  })

  it('returns a caller-provided fallback for corrupt JSON', () => {
    expect(jsonValue('invalid', { safe: true })).toEqual({ safe: true })
    expect(jsonValue('{"safe":false}', { safe: true })).toEqual({ safe: false })
  })

  it('rejects scene timeouts that cannot be represented safely by the runtime', () => {
    for (const value of [0, 1.5, 35792, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateSceneTimeout(value)).toThrow('任务超时')
    }
    expect(() => validateSceneTimeout(undefined)).not.toThrow()
    expect(() => validateSceneTimeout(35791)).not.toThrow()
  })
})
