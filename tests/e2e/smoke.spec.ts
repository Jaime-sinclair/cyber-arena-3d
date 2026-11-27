import { expect, test } from '@playwright/test'

/**
 * Smoke tests: verify the built site actually boots, renders WebGL content,
 * starts a run, and reacts to input — catching the "white screen on Pages"
 * class of failure before deployment.
 */
test('boots to the menu without console errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', err => errors.push(String(err)))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#menu')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('#menu h1')).toContainText('RANGE')
  await page.waitForTimeout(1000)
  expect(errors).toEqual([])
})

test('starts a solo run, spawns the HUD, and reacts to typing', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', err => errors.push(String(err)))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#menu')).toBeVisible({ timeout: 30_000 })

  await page.locator('.btn', { hasText: 'SOLO DRILL' }).click()
  const hud = page.locator('#hud')
  await expect(hud).toBeVisible({ timeout: 20_000 })
  // The run clock starts ticking (any value past 00:00 — software renderers
  // can be slow, so allow generous time rather than assuming 60 fps).
  await expect(page.locator('#hud .hud-time')).not.toHaveText('00:00', { timeout: 40_000 })

  // Type something — combat keys must not crash and the HUD must stay alive.
  await page.keyboard.type('ASDF')
  await page.waitForTimeout(800)
  await expect(hud).toBeVisible()

  // Curriculum panel & camera mode switcher must render and cycle via Tab without breaking typing.
  await expect(page.locator('#hud .curr-panel')).toBeVisible()
  await expect(page.locator('#hud .cam-chip')).toContainText('STANDARD')
  await page.keyboard.press('Tab')
  await expect(page.locator('#hud .cam-chip')).toContainText('WIDE TACTICAL')
  await page.keyboard.press('Tab')
  await expect(page.locator('#hud .cam-chip')).toContainText('COMBAT FOCUS')
  await page.keyboard.press('Tab')
  await expect(page.locator('#hud .cam-chip')).toContainText('OVERVIEW')

  expect(errors).toEqual([])
})

test('how-to-play overlay opens and closes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', err => errors.push(String(err)))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#menu')).toBeVisible({ timeout: 30_000 })
  await page.locator('.btn', { hasText: 'HOW TO PLAY' }).click()
  await expect(page.locator('.card h2')).toHaveText('HOW TO PLAY')
  await page.locator('.card .row-actions .btn', { hasText: 'CLOSE' }).click()
  await expect(page.locator('#menu')).toBeVisible()
  expect(errors).toEqual([])
})
