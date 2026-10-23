/**
 * One framing for check counts everywhere: "36/36 checks pass", with the earlier
 * attempt as "28/36 before". Passing first, total second, never failed counts.
 */
export const checkFraction = (passing: number, total: number): string => `${passing}/${total}`

export const checksPass = (passing: number, total: number): string =>
  `${checkFraction(passing, total)} ${total === 1 ? 'check passes' : 'checks pass'}`
