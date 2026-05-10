package main

import (
	"encoding/json"
	"sync"
	"time"
)

const (
	physicsHz   = 60
	broadcastHz = 20
)

// Game owns all player state and runs the authoritative physics loop.
type Game struct {
	hub     *Hub
	mu      sync.RWMutex
	players map[string]*Player
}

func NewGame(hub *Hub) *Game {
	return &Game{
		hub:     hub,
		players: make(map[string]*Player),
	}
}

func (g *Game) AddPlayer(p *Player) {
	g.mu.Lock()
	g.players[p.State.ID] = p
	g.mu.Unlock()
}

func (g *Game) RemovePlayer(id string) {
	g.mu.Lock()
	delete(g.players, id)
	g.mu.Unlock()
}

func (g *Game) HandleInput(playerID string, inp Input) {
	g.mu.Lock()
	if p, ok := g.players[playerID]; ok {
		p.Input = inp
	}
	g.mu.Unlock()
}

func (g *Game) SetPlayerName(playerID, name string) {
	g.mu.Lock()
	if p, ok := g.players[playerID]; ok {
		if len(name) > 16 {
			name = name[:16]
		}
		p.State.Name = name
	}
	g.mu.Unlock()
}

// Run starts the physics and broadcast tickers; call in a goroutine.
func (g *Game) Run() {
	physicsTick := time.NewTicker(time.Second / physicsHz)
	broadcastTick := time.NewTicker(time.Second / broadcastHz)
	defer physicsTick.Stop()
	defer broadcastTick.Stop()

	for {
		select {
		case <-physicsTick.C:
			g.update(1.0 / physicsHz)
		case <-broadcastTick.C:
			g.broadcast()
		}
	}
}

func (g *Game) update(dt float64) {
	g.mu.Lock()
	for _, p := range g.players {
		p.Update(dt)
	}
	g.mu.Unlock()
}

func (g *Game) broadcast() {
	g.mu.RLock()
	states := make([]PlayerState, 0, len(g.players))
	for _, p := range g.players {
		states = append(states, p.State)
	}
	g.mu.RUnlock()

	msg, err := json.Marshal(map[string]interface{}{
		"type":    "state",
		"players": states,
	})
	if err != nil {
		return
	}
	g.hub.Broadcast(msg)
}
