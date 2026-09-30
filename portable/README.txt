B1 PREP PORTABLE - WINDOWS 10/11 x64

Double-click B1 Prep.exe (the B1 Prep icon) in this folder. The included runtime
starts the app and your default browser opens when it is ready. No Node installation
is needed. start.cmd is an alternative launcher if you prefer it.
Keep the whole folder together. It works when the SSD gets another drive letter.
The normal address is http://127.0.0.1:4381.

Keep the console window open while studying. Your progress and learner settings
are saved to progress.json in this folder; progress.json.bak is the previous save.
The copied .env file contains your AI configuration and API key, so it travels
with the SSD too. Keep the SSD and copies of this folder private.

Before unplugging: wait for the app's saved status (or use Save now in Settings),
close its browser tab, press Ctrl+C in the console, and wait for it to stop.
Then use Windows Safely Remove Hardware/Eject. Keep a backup of your progress.

Bundled study content works offline. AI features need internet and your API key.
Network speech voices and dictation may need internet; available German voices,
microphone permissions and theme preference depend on the computer/browser.

If startup reports the port is occupied, close the other running copy. To choose
another port, open a terminal in this folder and run:
  start.cmd --port 4323
The launcher never opens an unrelated app already using the selected port.

For an isolated check without opening a browser:
  start.cmd --no-browser --port 4332 --progress-file "C:\existing-folder\test-progress.json"
The test progress path must be absolute and its folder must already exist.

This package includes the Windows x64 runtime. It cannot run directly on macOS.

ONE-TIME SYNC AFTER THE OFFICE

After returning to your home PC, connect this SSD. Save your work and close both
B1 Prep browser tabs and server/launcher windows. Double-click Sync-to-Home.cmd.
It merges the SSD's study progress into D:\B1_Prep and backs up the previous home
record first. The SSD's progress, API keys and application files are unchanged.
It runs only on the configured home PC. After a successful sync, further clicks
report that it has already completed. There is no automatic or scheduled sync.
Then start your usual home B1 Prep shortcut again to load the combined progress.
