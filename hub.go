package main

import (
	crand "crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

var kartColors = []string{
	"#e74c3c", "#3498db", "#2ecc71", "#f1c40f",
	"#9b59b6", "#1abc9c", "#e67e22", "#e91e63",
}

// Hub manages all connected clients and owns the Game instance.
type Hub struct {
	mu      sync.RWMutex
	clients map[string]*Client
	game    *Game
	nextIdx int
}

func NewHub() *Hub {
	h := &Hub{clients: make(map[string]*Client)}
	h.game = NewGame(h)
	return h
}

func (h *Hub) Run() {
	h.game.Run()
}

// ServeWS upgrades an HTTP request to a WebSocket and registers the player.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade:", err)
		return
	}

	h.mu.Lock()
	idx := h.nextIdx
	h.nextIdx++
	color := kartColors[idx%len(kartColors)]

	client := &Client{
		ID:   generateID(),
		conn: conn,
		hub:  h,
		send: make(chan []byte, 256),
	}

	player := &Player{
		State: PlayerState{
			ID:    client.ID,
			Name:  fmt.Sprintf("Racer %d", idx+1),
			Color: color,
		},
		Client: client,
	}
	player.SpawnPosition(idx)

	h.clients[client.ID] = client
	h.game.AddPlayer(player)
	h.mu.Unlock()

	initMsg, _ := json.Marshal(map[string]interface{}{
		"type":   "init",
		"yourId": client.ID,
		"color":  color,
		"laps":   totalLaps,
	})
	client.send <- initMsg

	log.Printf("player %s joined (slot %d)", client.ID, idx)

	go client.writePump()
	client.readPump() // blocks until disconnect
}

// Broadcast sends msg to every connected client (non-blocking per client).
func (h *Hub) Broadcast(msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		select {
		case c.send <- msg:
		default:
		}
	}
}

// RemoveClient disconnects and cleans up a player.
func (h *Hub) RemoveClient(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c, ok := h.clients[id]; ok {
		delete(h.clients, id)
		close(c.send)
		h.game.RemovePlayer(id)
		log.Printf("player %s left", id)
	}
}

func generateID() string {
	b := make([]byte, 8)
	crand.Read(b)
	return fmt.Sprintf("%x", b)
}
