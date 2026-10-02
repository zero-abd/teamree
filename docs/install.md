# Installing teamree

teamree is unsigned, so macOS blocks it the first time. These steps get you past that.

1. Download the latest build (macOS, Apple Silicon or Intel):
   <https://github.com/zero-abd/teamree/releases/latest/download/teamree-mac-universal.dmg>
2. Open the `.dmg` and drag **teamree** to **Applications**.
3. Open teamree. macOS says **"teamree" Not Opened**. Press **Done**, not **Move to Trash**.
4. In Terminal, run the command below. Or go to **System Settings → Privacy & Security** and press **Open Anyway** next to teamree.

```sh
xattr -dr com.apple.quarantine /Applications/teamree.app
```

5. Open teamree again. It won't ask again, and updates install themselves from now on.

## Optional

- **Check the download:** run `shasum -a 256 ~/Downloads/teamree-mac-universal.dmg` and compare it with the line for that file in the release's `SHA256SUMS.txt`.
- **`teamree` command:** teamree offers to link it on first launch, or use **Put teamree on my PATH** in the sidebar.
- **Uninstall:** drag `teamree.app` to the Trash. Settings live in `~/Library/Application Support/teamree`. If you linked the command, run `sudo rm /usr/local/bin/teamree`.
