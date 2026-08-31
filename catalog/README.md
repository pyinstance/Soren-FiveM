# Discovery catalogue

Soren FiveM v1.8 reads this folder from GitHub at runtime.

## Add a pack

Add two URLs to the category text file, in this order:

```text
https://example.com/preview.mp4
https://example.com/download.zip
```

## Add a category

Create another `.txt` file in this folder and commit/push it. For example:

```text
Weapon Animations

https://example.com/preview.mp4
https://example.com/download.rar
```

The first non-URL line is the display name. If there is no heading, Soren uses the `.txt` filename.

Users receive catalogue changes on app launch, when they press Reload, or during the periodic catalogue refresh. Catalogue changes do not require a new EXE build.
