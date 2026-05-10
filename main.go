package main

import (
	"log"
	"net/http"
	"os"
)

func main() {
	hub := NewHub()
	go hub.Run()

	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))
	http.HandleFunc("/ws", hub.ServeWS)
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "static/index.html")
	})

	port := "8080"
	if p := os.Getenv("PORT"); p != "" {
		port = p
	}

	log.Printf("GoCart server listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
