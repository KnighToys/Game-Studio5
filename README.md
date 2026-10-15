### **Dream Matrix**
This project is also under construction, please wait until the final presentation date...

Development checks (Node.js 24+):

```sh
npm test
node scripts/smoke-gameplay.mjs
```

The browser smoke check requires Chromium (`CHROMIUM_PATH` overrides its path).
It starts and stops its own game server and browser, checks scene loading,
shooting, input reset, and player height. In the cloud environment it uses
`/workspace/game-studio5-runtime` for Linux dependencies; set `GAME_RUNTIME_DIR`
to use another prepared checkout.
