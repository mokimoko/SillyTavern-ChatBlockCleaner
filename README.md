# ChatBlockCleaner

ChatBlockCleaner removes tagged XML blocks and everything inside them from a SillyTavern chat.

## Usage

- Enter the tag you want to remove, such as `analyze`, which would remove all blocks (and their contents) tagged this: `<analyze>...</analyze>`
- **Scan current chat** shows how many blocks it found.
- **Export cleaned TXT** downloads a clean copy without changing your chat.
- **Remove blocks** permanently removes them from the current saved chat.

Only complete blocks with both an opening and closing tag are removed.
