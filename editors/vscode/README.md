# MK for Visual Studio Code

Syntax highlighting for [MK](https://github.com/maksimkrulj/mkcode). It covers keywords, signals,
`query` / `insert` / `update` / `delete` clauses, `consume`, string interpolation (`"${expr}"`),
types, built-ins and comments. It also sets up bracket matching, auto-closing pairs and
indentation.

## Install from source

```bash
cd editors/vscode
npx @vscode/vsce package     # creates mk-lang-0.1.0.vsix
code --install-extension mk-lang-0.1.0.vsix
```

You can also copy this folder to `~/.vscode/extensions/mk-lang` and restart VS Code.

## `.mk` files open as Makefiles?

VS Code's built-in Makefile support also claims `.mk`. To make MK the default, add this to your
`settings.json`:

```json
"files.associations": { "*.mk": "mk" }
```
