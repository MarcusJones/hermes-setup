---
name: obsidian
description: Read, search, and create notes in the Obsidian vault.
---

# Obsidian Vault

**Shared Vault Path:** `/home/hermes/vaults/shared`

Note: Vault paths may contain spaces - always quote them.

## Read a note

```bash
VAULT="/home/hermes/vaults/private/personal"
cat "$VAULT/Note Name.md"
```

## List notes

```bash
VAULT="/home/hermes/vaults/private/personal"

# All notes
find "$VAULT" -name "*.md" -type f

# In a specific folder
ls "$VAULT/Subfolder/"
```

## Search

```bash
VAULT="/home/hermes/vaults/private/personal"

# By filename
find "$VAULT" -name "*.md" -iname "keyword*"

# By content
grep -rli "keyword" "$VAULT" --include="*.md"
```

## Create a note

```bash
VAULT="/home/hermes/vaults/private/personal"
cat > "$VAULT/New Note.md" << 'ENDNOTE'
# Title

Content here.
ENDNOTE
```

## Append to a note

```bash
VAULT="/home/hermes/vaults/private/personal"
echo "
New content here." >> "$VAULT/Existing Note.md"
```

## Wikilinks

Obsidian links notes with `[[Note Name]]` syntax. When creating notes, use these to link related content.
