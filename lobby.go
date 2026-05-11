package main

import (
	crand "crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"sync"
	"time"
)

const (
	lobbyCodeLen       = 6
	maxPlayersPerLobby = 8
	emptyLobbyTTL      = 30 * time.Second

	// Public quick-match lobby; recreated when full.
	quickMatchPrefix = "PUBLIC"
)

// Code alphabet excludes ambiguous chars (0/O, 1/I/L) so codes are easy to share.
const lobbyAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

var kartColors = []string{
	"#e74c3c", "#3498db", "#2ecc71", "#f1c40f",
	"#9b59b6", "#1abc9c", "#e67e22", "#e91e63",
}

// Lobby is a private race room with its own physics loop and member list.
type Lobby struct {
	Code         string
	IsPrivate    bool
	passwordHash []byte // empty when no password
	created      time.Time

	mu      sync.RWMutex
	members map[string]*Client
	game    *Game
	nextIdx int
	stop    chan struct{}
	emptyAt time.Time // zero unless lobby is currently empty
}

func newLobby(code string, isPrivate bool, password string) *Lobby {
	l := &Lobby{
		Code:      code,
		IsPrivate: isPrivate,
		created:   time.Now(),
		members:   make(map[string]*Client),
		stop:      make(chan struct{}),
	}
	if password != "" {
		l.passwordHash = hashPassword(password)
	}
	l.game = NewGame(l)
	go l.game.Run(l.stop)
	return l
}

// checkPassword returns true if the supplied password matches.
// Comparison is constant-time so timing leaks can't enumerate hashes.
func (l *Lobby) checkPassword(password string) bool {
	if len(l.passwordHash) == 0 {
		return true
	}
	candidate := hashPassword(password)
	return subtle.ConstantTimeCompare(l.passwordHash, candidate) == 1
}

func (l *Lobby) Broadcast(msg []byte) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	for _, c := range l.members {
		select {
		case c.send <- msg:
		default:
		}
	}
}

// addPlayer registers the client, allocates a colour + spawn slot, and returns
// the assigned colour so the caller can ack the join.
func (l *Lobby) addPlayer(c *Client, name string) string {
	l.mu.Lock()
	defer l.mu.Unlock()

	idx := l.nextIdx
	l.nextIdx++
	color := kartColors[idx%len(kartColors)]

	p := &Player{
		State: PlayerState{
			ID:    c.ID,
			Name:  name,
			Color: color,
		},
		Client: c,
	}
	p.SpawnPosition(idx)

	l.members[c.ID] = c
	l.game.AddPlayer(p)
	l.emptyAt = time.Time{}
	return color
}

// removePlayer drops a member; returns true if the lobby is now empty.
func (l *Lobby) removePlayer(id string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if c, ok := l.members[id]; ok {
		delete(l.members, id)
		close(c.send)
	}
	l.game.RemovePlayer(id)
	if len(l.members) == 0 {
		l.emptyAt = time.Now()
		return true
	}
	return false
}

func (l *Lobby) isFull() bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return len(l.members) >= maxPlayersPerLobby
}

func (l *Lobby) memberCount() int {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return len(l.members)
}

func (l *Lobby) shutdown() {
	select {
	case <-l.stop:
		// already closed
	default:
		close(l.stop)
	}
}

// hashPassword produces a fixed-length digest suitable for constant-time compare.
// Lobby passwords are ephemeral and never persisted, so a fast hash is fine —
// the salting/work-factor reasons for bcrypt don't apply here.
func hashPassword(p string) []byte {
	h := sha256.Sum256([]byte(p))
	return h[:]
}

// generateLobbyCode draws lobbyCodeLen chars from the unambiguous alphabet
// using crypto/rand. With 31^6 ≈ 887M combinations, collisions are vanishingly
// rare; the caller still retries on collision.
func generateLobbyCode() string {
	b := make([]byte, lobbyCodeLen)
	if _, err := crand.Read(b); err != nil {
		// crand.Read essentially never fails on supported platforms; fall through.
	}
	out := make([]byte, lobbyCodeLen)
	for i, v := range b {
		out[i] = lobbyAlphabet[int(v)%len(lobbyAlphabet)]
	}
	return string(out)
}
