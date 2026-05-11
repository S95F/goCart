package main

import (
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = pongWait * 9 / 10
	maxMessageSize = 1024
)

// Client wraps a single WebSocket connection. A client is associated with at
// most one Lobby for the lifetime of the connection.
type Client struct {
	ID    string
	conn  *websocket.Conn
	hub   *Hub
	lobby *Lobby
	send  chan []byte

	closeSendOnce sync.Once
}

type incomingMsg struct {
	Type     string `json:"type"`
	Forward  bool   `json:"forward"`
	Back     bool   `json:"back"`
	Left     bool   `json:"left"`
	Right    bool   `json:"right"`
	Boost    bool   `json:"boost"`
	Name     string `json:"name"`
	Code     string `json:"code"`
	Password string `json:"password"`
	Private  bool   `json:"private"`
}

func (c *Client) readPump() {
	defer c.cleanup()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("client %s read error: %v", c.ID, err)
			}
			return
		}

		var msg incomingMsg
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}

		switch msg.Type {
		case "createLobby":
			c.handleCreateLobby(msg)
		case "joinLobby":
			c.handleJoinLobby(msg)
		case "quickMatch":
			c.handleQuickMatch(msg)

		case "input":
			if c.lobby != nil {
				c.lobby.game.HandleInput(c.ID, Input{
					Forward: msg.Forward,
					Back:    msg.Back,
					Left:    msg.Left,
					Right:   msg.Right,
					Boost:   msg.Boost,
				})
			}
		case "setName":
			if c.lobby != nil {
				c.lobby.game.SetPlayerName(c.ID, msg.Name)
			}
		}
	}
}

// handleCreateLobby spins up a new lobby and joins the requesting client.
func (c *Client) handleCreateLobby(msg incomingMsg) {
	if c.lobby != nil {
		c.sendLobbyError("already_in_lobby")
		return
	}
	l := c.hub.CreateLobby(msg.Private, msg.Password)
	if l == nil {
		c.sendLobbyError("lobby_alloc_failed")
		return
	}
	c.joinLobby(l, sanitiseName(msg.Name))
}

func (c *Client) handleJoinLobby(msg incomingMsg) {
	if c.lobby != nil {
		c.sendLobbyError("already_in_lobby")
		return
	}
	l, errCode := c.hub.FindLobby(msg.Code, msg.Password)
	if errCode != "" {
		c.sendLobbyError(errCode)
		return
	}
	c.joinLobby(l, sanitiseName(msg.Name))
}

func (c *Client) handleQuickMatch(msg incomingMsg) {
	if c.lobby != nil {
		c.sendLobbyError("already_in_lobby")
		return
	}
	l := c.hub.QuickMatch()
	if l == nil {
		c.sendLobbyError("lobby_alloc_failed")
		return
	}
	c.joinLobby(l, sanitiseName(msg.Name))
}

// joinLobby finalises lobby membership and sends the joined ack.
func (c *Client) joinLobby(l *Lobby, name string) {
	color := l.addPlayer(c, name)
	c.lobby = l

	ack, _ := json.Marshal(map[string]interface{}{
		"type":      "joined",
		"code":      l.Code,
		"color":     color,
		"isPrivate": l.IsPrivate,
	})
	select {
	case c.send <- ack:
	default:
	}

	log.Printf("player %s (%s) joined lobby %s", c.ID, name, l.Code)
}

func (c *Client) sendLobbyError(code string) {
	msg, _ := json.Marshal(map[string]interface{}{
		"type":  "lobbyError",
		"error": code,
	})
	select {
	case c.send <- msg:
	default:
	}
}

func sanitiseName(n string) string {
	n = strings.TrimSpace(n)
	if n == "" {
		n = "Racer"
	}
	if len(n) > 16 {
		n = n[:16]
	}
	return n
}

func (c *Client) cleanup() {
	if c.lobby != nil {
		// removePlayer closes the send channel.
		c.lobby.removePlayer(c.ID)
		log.Printf("player %s left lobby %s", c.ID, c.lobby.Code)
	} else {
		c.closeSend()
	}
	c.conn.Close()
}

// closeSend safely closes the send channel exactly once.
func (c *Client) closeSend() {
	c.closeSendOnce.Do(func() { close(c.send) })
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
