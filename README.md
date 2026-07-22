# 📚 Study Aid

A personal study app: organize your courses, upload course content, and let Claude
turn it into **multiple-choice quizzes** and **flashcards** you can review right in
the browser.

No build step, no backend, no database — just static files. All of your data
(courses, materials, quizzes, decks, scores) is stored in your browser's
localStorage.

## Getting started

1. **Serve the app** (any static server works):

   ```sh
   cd study-aid
   python3 -m http.server 8000
   ```

   Then open <http://localhost:8000>.

2. **Add your Anthropic API key** — click the ⚙️ icon in the sidebar and paste a
   key from [platform.claude.com](https://platform.claude.com/). The key is stored
   only in your browser's localStorage and sent only to `api.anthropic.com`.

3. **Create a course** in the sidebar (e.g. "BIO 201", "Corporate Finance").

4. **Upload content** in the *Materials* tab — drag in `.txt`, `.md`, or `.pdf`
   files (text is extracted client-side via pdf.js), or paste notes directly.

5. **Generate** — in the *Generate* tab, pick which materials to use, choose
   quiz questions and/or flashcards, item count, difficulty, and an optional
   topic focus, then hit ✨ Generate.

6. **Study** —
   - *Quizzes*: questions are shuffled each attempt, with instant feedback and
     explanations for every answer; your best score per quiz and overall course
     accuracy are tracked.
   - *Flashcards*: click to flip, mark **Got it** or **Review again** (cards you
     miss recycle to the end of the deck).

## Notes

- Generation uses the Claude Messages API (`claude-opus-4-8`) with structured
  JSON-schema outputs, called directly from the browser via the
  `anthropic-dangerous-direct-browser-access` header. This pattern is meant for
  **personal/local use** — don't deploy this publicly with your key.
- **Export/Import** buttons in the sidebar back up all data as JSON so you can
  move between browsers or machines.
- Scanned/image-only PDFs have no extractable text and will be rejected — paste
  the text instead.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell and markup |
| `styles.css` | Styling |
| `app.js` | State, rendering, quiz/flashcard players, and the Claude API client |
