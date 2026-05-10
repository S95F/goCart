package main

import "math"

// Input holds the current control state sent from a client each frame.
type Input struct {
	Forward bool `json:"forward"`
	Back    bool `json:"back"`
	Left    bool `json:"left"`
	Right   bool `json:"right"`
	Boost   bool `json:"boost"`
}

// PlayerState is the authoritative server-side state broadcast to all clients.
type PlayerState struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Z        float64 `json:"z"`
	RotY     float64 `json:"rotY"`
	Speed    float64 `json:"speed"`
	Color    string  `json:"color"`
	Lap      int     `json:"lap"`
	Finished bool    `json:"finished"`
}

// Player pairs a WebSocket client with its physics state.
type Player struct {
	State  PlayerState
	Input  Input
	Client *Client

	lastZ      float64
	crossedTop bool // must reach the top of track before lap counts
}

const (
	maxForwardSpeed = 40.0
	maxReverseSpeed = 14.0
	accelRate       = 20.0
	brakeRate       = 28.0
	frictionRate    = 12.0
	turnRate        = 2.4

	trackInnerRadius = 55.0
	trackOuterRadius = 85.0
	totalLaps        = 3
)

// SpawnPosition places the player at the starting grid position for their slot.
func (p *Player) SpawnPosition(index int) {
	col := float64(index % 2)
	row := float64(index / 2)
	// Start grid on the right straight, just past the start line (Z positive)
	p.State.X = 73.0 - col*6.0
	p.State.Z = 8.0 + row*12.0
	p.State.Y = 0
	p.State.RotY = 0 // facing +Z (counterclockwise)
	p.State.Speed = 0
	p.State.Lap = 0
	p.State.Finished = false
	p.lastZ = p.State.Z
	p.crossedTop = false
}

// Update advances physics by dt seconds.
func (p *Player) Update(dt float64) {
	s := &p.State

	if s.Finished {
		applyFriction(s, dt)
		move(s, dt)
		return
	}

	inp := p.Input
	maxSpd := maxForwardSpeed
	if inp.Boost {
		maxSpd *= 1.55
	}

	if inp.Forward {
		s.Speed += accelRate * dt
	} else if inp.Back {
		if s.Speed > 0 {
			s.Speed -= brakeRate * dt
		} else {
			s.Speed -= accelRate * 0.5 * dt
		}
	} else {
		applyFriction(s, dt)
	}

	if s.Speed > maxSpd {
		s.Speed = maxSpd
	}
	if s.Speed < -maxReverseSpeed {
		s.Speed = -maxReverseSpeed
	}

	// Steering scales with normalised speed so the kart feels planted at low speed.
	speedFactor := math.Abs(s.Speed) / maxForwardSpeed
	if speedFactor > 1 {
		speedFactor = 1
	}
	if speedFactor > 0.04 {
		turn := turnRate * speedFactor * dt
		if s.Speed < 0 {
			turn = -turn
		}
		if inp.Left {
			s.RotY += turn
		}
		if inp.Right {
			s.RotY -= turn
		}
	}

	move(s, dt)
	p.wallBounce()
	p.checkLap()
}

func applyFriction(s *PlayerState, dt float64) {
	if s.Speed > 0 {
		s.Speed -= frictionRate * dt
		if s.Speed < 0 {
			s.Speed = 0
		}
	} else if s.Speed < 0 {
		s.Speed += frictionRate * dt
		if s.Speed > 0 {
			s.Speed = 0
		}
	}
}

func move(s *PlayerState, dt float64) {
	s.X += math.Sin(s.RotY) * s.Speed * dt
	s.Z += math.Cos(s.RotY) * s.Speed * dt
}

// wallBounce pushes the kart back inside track boundaries and kills speed.
func (p *Player) wallBounce() {
	s := &p.State
	dist := math.Sqrt(s.X*s.X + s.Z*s.Z)
	if dist == 0 {
		dist = 0.001
	}
	if dist < trackInnerRadius {
		factor := trackInnerRadius / dist
		s.X *= factor
		s.Z *= factor
		s.Speed *= 0.4
	} else if dist > trackOuterRadius {
		factor := trackOuterRadius / dist
		s.X *= factor
		s.Z *= factor
		s.Speed *= 0.4
	}
}

// checkLap counts a lap each time the player crosses Z=0 going in the +Z
// direction (counterclockwise) while on the right straight (X > 55).
// A crossedTop guard prevents false triggers at spawn.
func (p *Player) checkLap() {
	s := &p.State

	// Mark that the player reached the far side of the track.
	if s.Z < -40 {
		p.crossedTop = true
	}

	if p.crossedTop && s.X > trackInnerRadius && p.lastZ < 0 && s.Z >= 0 {
		s.Lap++
		p.crossedTop = false
		if s.Lap >= totalLaps {
			s.Lap = totalLaps
			s.Finished = true
		}
	}

	p.lastZ = s.Z
}
