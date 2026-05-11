package main

import (
	crand "crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Hub owns the WebSocket endpoint and the lobby registry.
type Hub struct {
	mu      sync.RWMutex
	lobbies map[string]*Lobby
}

func NewHub() *Hub {
	h := &Hub{lobbies: make(map[string]*Lobby)}
	go h.reaper()
	return h
}

// Run is a no-op kept for API compatibility — physics ticks are per-lobby.
func (h *Hub) Run() {}

// ServeWS upgrades the connection and sends an init message. The client must
// then send createLobby/joinLobby/quickMatch to enter a race.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade:", err)
		return
	}

	client := &Client{
		ID:   generateID(),
		conn: conn,
		hub:  h,
		send: make(chan []byte, 256),
	}

	initMsg, _ := json.Marshal(map[string]interface{}{
		"type":   "init",
		"yourId": client.ID,
		"laps":   totalLaps,
	})
	client.send <- initMsg

	go client.writePump()
	client.readPump() // blocks until disconnect
}

// CreateLobby allocates a new lobby with a fresh unambiguous code.
// Returns nil if the code space is exhausted (effectively never).
func (h *Hub) CreateLobby(isPrivate bool, password string) *Lobby {
	h.mu.Lock()
	defer h.mu.Unlock()
	for tries := 0; tries < 16; tries++ {
		code := generateLobbyCode()
		if _, exists := h.lobbies[code]; exists {
			continue
		}
		l := newLobby(code, isPrivate, password)
		h.lobbies[code] = l
		log.Printf("lobby %s created (private=%v, password=%v)",
			code, isPrivate, password != "")
		return l
	}
	return nil
}

// FindLobby looks up a lobby by code (uppercased) and validates the password.
// Returns the lobby or an error code: "no_such_lobby", "wrong_password", "lobby_full".
func (h *Hub) FindLobby(code, password string) (*Lobby, string) {
	code = strings.ToUpper(strings.TrimSpace(code))
	h.mu.RLock()
	l := h.lobbies[code]
	h.mu.RUnlock()
	if l == nil {
		return nil, "no_such_lobby"
	}
	if !l.checkPassword(password) {
		return nil, "wrong_password"
	}
	if l.isFull() {
		return nil, "lobby_full"
	}
	return l, ""
}

// QuickMatch returns the singleton public lobby, creating one if missing or full.
func (h *Hub) QuickMatch() *Lobby {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Find an existing public lobby with room.
	for _, l := range h.lobbies {
		if !l.IsPrivate && !l.isFull() {
			return l
		}
	}
	// Otherwise spin up a new one.
	for tries := 0; tries < 16; tries++ {
		code := quickMatchPrefix + "-" + generateLobbyCode()
		if _, exists := h.lobbies[code]; exists {
			continue
		}
		l := newLobby(code, false, "")
		h.lobbies[code] = l
		log.Printf("quick-match lobby %s created", code)
		return l
	}
	return nil
}

// removeLobby unregisters a lobby (used after final disconnect when callers
// want immediate teardown rather than waiting for the reaper).
func (h *Hub) removeLobby(code string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if l, ok := h.lobbies[code]; ok {
		l.shutdown()
		delete(h.lobbies, code)
	}
}

// reaper deletes lobbies that have been empty longer than emptyLobbyTTL.
func (h *Hub) reaper() {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for range t.C {
		var toReap []string

		h.mu.RLock()
		for code, l := range h.lobbies {
			l.mu.RLock()
			if len(l.members) == 0 && !l.emptyAt.IsZero() && time.Since(l.emptyAt) > emptyLobbyTTL {
				toReap = append(toReap, code)
			}
			l.mu.RUnlock()
		}
		h.mu.RUnlock()

		if len(toReap) == 0 {
			continue
		}

		h.mu.Lock()
		for _, code := range toReap {
			l, ok := h.lobbies[code]
			if !ok {
				continue
			}
			l.mu.RLock()
			stillEmpty := len(l.members) == 0
			l.mu.RUnlock()
			if stillEmpty {
				l.shutdown()
				delete(h.lobbies, code)
				log.Printf("lobby %s reaped", code)
			}
		}
		h.mu.Unlock()
	}
}

func generateID() string {
	b := make([]byte, 8)
	crand.Read(b)
	return fmt.Sprintf("%x", b)
}
