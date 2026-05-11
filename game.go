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

// Game owns the physics loop for a single lobby.
type Game struct {
	lobby   *Lobby
	mu      sync.RWMutex
	players map[string]*Player
}

func NewGame(lobby *Lobby) *Game {
	return &Game{
		lobby:   lobby,
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

// Run drives the physics + broadcast tickers until stop is closed.
func (g *Game) Run(stop <-chan struct{}) {
	physicsTick := time.NewTicker(time.Second / physicsHz)
	broadcastTick := time.NewTicker(time.Second / broadcastHz)
	defer physicsTick.Stop()
	defer broadcastTick.Stop()

	for {
		select {
		case <-stop:
			return
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
	g.lobby.Broadcast(msg)
}
