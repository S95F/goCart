package main

import (
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = pongWait * 9 / 10
	maxMessageSize = 512
)

// Client wraps a single WebSocket connection.
type Client struct {
	ID   string
	conn *websocket.Conn
	hub  *Hub
	send chan []byte
}

type incomingMsg struct {
	Type    string `json:"type"`
	Forward bool   `json:"forward"`
	Back    bool   `json:"back"`
	Left    bool   `json:"left"`
	Right   bool   `json:"right"`
	Boost   bool   `json:"boost"`
	Name    string `json:"name"`
}

func (c *Client) readPump() {
	defer func() {
		c.hub.RemoveClient(c.ID)
		c.conn.Close()
	}()

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
		case "input":
			c.hub.game.HandleInput(c.ID, Input{
				Forward: msg.Forward,
				Back:    msg.Back,
				Left:    msg.Left,
				Right:   msg.Right,
				Boost:   msg.Boost,
			})
		case "setName":
			c.hub.game.SetPlayerName(c.ID, msg.Name)
		}
	}
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
