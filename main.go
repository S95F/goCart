package main

import (
	"flag"
	"log"
	"net/http"
	"os"
)

func main() {
	// -port flag is injected by serverGitUpdater at service start.
	// Falls back to the PORT env var, then the compiled-in default.
	portFlag := flag.String("port", "", "TCP port to listen on")
	flag.Parse()

	port := "8080"
	switch {
	case *portFlag != "":
		port = *portFlag
	case os.Getenv("PORT") != "":
		port = os.Getenv("PORT")
	}

	hub := NewHub()
	go hub.Run()

	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))
	http.HandleFunc("/ws", hub.ServeWS)
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "static/index.html")
	})

	log.Printf("GoCart server listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
