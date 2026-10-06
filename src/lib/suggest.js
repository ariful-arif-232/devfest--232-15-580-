// Filename -> requirement suggestions. Purely advisory; never applied automatically.

const STOP = new Set(['of', 'the', 'and', 'for', 'a', 'an', 'to', 'in', 'on', 's', 'pdf', 'copy', 'scan', 'final', 'signed', 'doc', 'document'])

function tokens(text) {
  return String(text)
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/'s\b/g, '')
    .split(/[^a-z0-9ঀ-৿]+/)
    .filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t))
}

function tokenMatch(a, b) {
  if (a === b) return true
  const min = Math.min(a.length, b.length)
  return min >= 3 && (a.startsWith(b) || b.startsWith(a))
}

function scoreTitle(ft, title, id) {
  const titleTokens = tokens(title)
  if (!titleTokens.length) return 0
  const rt = titleTokens.concat(tokens(id))
  const hits = titleTokens.filter((t) => ft.some((f) => tokenMatch(f, t))).length
  const fileHits = ft.filter((f) => rt.some((t) => tokenMatch(f, t))).length
  // Balance coverage of the title with how much of the filename is explained.
  return (hits / titleTokens.length) * 0.6 + (fileHits / ft.length) * 0.4
}

// Scores a filename against both the English and Bangla titles and keeps the better one.
function score(fileName, req) {
  const ft = tokens(fileName)
  if (!ft.length) return 0
  return Math.max(scoreTitle(ft, req.title_en, req.id), scoreTitle(ft, req.title_bn, req.id))
}

// Returns { [reqId]: fileId } for unmatched requirements with one clear best unmatched file.
export function suggestMatches(requirements, files, matches) {
  const used = new Set(Object.values(matches))
  const free = files.filter((f) => !used.has(f.id))
  const usedHashes = new Set(files.filter((f) => used.has(f.id)).map((f) => f.hash))
  const result = {}
  const taken = new Set()
  for (const req of requirements) {
    if (matches[req.id]) continue
    let best = []
    let bestScore = 0.5
    for (const f of free) {
      if (taken.has(f.hash) || usedHashes.has(f.hash)) continue
      const s = score(f.name, req)
      if (s > bestScore + 1e-9) {
        best = [f]
        bestScore = s
      } else if (Math.abs(s - bestScore) < 1e-9 && best.length) {
        best.push(f)
      }
    }
    // Ties between files with different content are ambiguous: let the user decide.
    if (best.length && best.every((f) => f.hash === best[0].hash)) {
      result[req.id] = best[0].id
      taken.add(best[0].hash)
    }
  }
  return result
}
