# Shapeshock

A 4-player online platform fighter that runs in the browser. Smash-style rules: damage % instead of a health bar, knockback that grows with damage, 3 stocks, ledges, shields, grabs, and recoveries. The four fighters are original characters built from simple shapes.

## Put it on GitHub Pages

1. Create a new repository and upload everything in this folder (keep the folder structure).
2. In the repo, go to **Settings → Pages**, set *Source* to **Deploy from a branch**, branch `main`, folder `/ (root)`, then save.
3. After a minute the game is live at `https://<your-username>.github.io/<repo-name>/`.

There's no build step. The browser loads the `js/` files directly as ES modules.

## Play online

- One person clicks **Host a game** and gets a 5-character code (or **Copy invite link**).
- Everyone else types the code and clicks **Join**. Up to 4 players.
- Everyone picks a fighter, then the host starts the match.
- If the host is alone, the start button becomes **Practice vs dummy**.

## Controls

| Action | Left-hand layout | Arrow layout |
|---|---|---|
| Move | W A S D | Arrow keys |
| Jump | Space or W | Space |
| Attack | J | Z |
| Special | K | X |
| Smash attack (hold to charge) | I | C |
| Shield / dodge | L or Shift | V or Shift |
| Grab | ; | B |

**W as jump ("tap jump", like Smash):** W jumps *and* aims up. W + Special or W + Smash on the ground becomes an up-special or up-smash instead of a jump, and W + Attack becomes an up-tilt. In the air, W waits 3 frames before double jumping, so W + Attack or W + Special gives an up-air or up-special without wasting your jump. Space is always a plain jump.

## How it's built

| File | Job |
|---|---|
| `js/config.js` | All tuning numbers (gravity, knockback, shield, timings) |
| `js/stage.js` | Stage geometry and blast zones |
| `js/characters.js` | The 4 fighters: stats plus moves as hitbox data |
| `js/fighter.js` | One fighter's state machine (idle, run, air, attack, shield, ledge…) |
| `js/game.js` | The match: collisions, hits and knockback, grabs, ledges, projectiles, KOs |
| `js/render.js` | Draws a snapshot on the canvas; animates limbs from hitbox data |
| `js/net.js` | PeerJS connections: host and guests, reliable and unreliable channels |
| `js/input.js` | Keyboard → button bits and press counters |
| `js/audio.js` | All sounds synthesized with Web Audio (no audio files) |
| `js/main.js` | Screens, lobby, and the host and guest game loops |

**Networking model:** the host runs the only copy of the simulation. Guests send button presses and receive snapshots 60 times a second, which they draw about 3 frames in the past so motion stays smooth. There's no rollback netcode, so guests feel their round-trip ping as input delay.

**Matchmaking** uses the free public PeerJS server (`0.peerjs.com`) only to introduce browsers to each other. After that, game data goes directly between players (WebRTC).

## Known limits

- **Some networks can't connect.** Strict corporate or school networks often block direct peer-to-peer connections, and there's no relay (TURN) server configured. Home networks usually work.
- **The host must keep the game visible.** Browsers pause animation in background tabs, and the host's tab runs the match. To test on one computer, use two separate *windows* side by side, not two tabs.
- **The public PeerJS server has occasional outages.** If hosting fails with a server error, wait and retry.

## Tests (need Node 18+)

```
node tests/fuzz-test.mjs       # 4 bots mash random buttons: checks crashes, NaN, stuck states
node tests/ko-test.mjs         # at what % each strong move KOs, centre stage vs ledge
node tests/recovery-test.mjs   # can each fighter make it back from off-stage?
node tests/tapjump-test.mjs    # W tap-jump rules
```

To test multiplayer locally without the public server, run your own PeerServer (`npx peerjs --port 9000`) and open the game with `?peer=127.0.0.1:9000` in the URL.
