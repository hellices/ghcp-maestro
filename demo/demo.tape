# VHS tape for the README demo GIF.
#   brew install vhs && vhs demo/demo.tape   (run from the repo root)
# Renders demo/replay.mjs — a scripted replay of a real /maestro task run.

Output docs/assets/demo.gif

Set FontSize 13
Set Width 1240
Set Height 620
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 0ms

Hide
Type "node demo/replay.mjs"
Enter
Show

# replay.mjs takes ~25s end-to-end; keep a small tail margin
Sleep 29s
