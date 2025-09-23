package main

import (
	"context"
	"log"
	"net/http"

	"connectrpc.com/connect"
)

const pingProcedure = "/ping.v1.PingService/Ping"

// PingRequest is a minimal request payload for testing connectivity.
type PingRequest struct {
	Message string `json:"message"`
}

// PingResponse is a minimal response payload for testing connectivity.
type PingResponse struct {
	Message string `json:"message"`
}

func main() {
	mux := http.NewServeMux()

	pingHandler := connect.NewUnaryHandler(
		pingProcedure,
		func(ctx context.Context, req *connect.Request[PingRequest]) (*connect.Response[PingResponse], error) {
			log.Printf("received ping: %s", req.Msg.Message)
			res := connect.NewResponse(&PingResponse{Message: "pong"})
			return res, nil
		},
	)

	mux.Handle(pingProcedure, pingHandler)

	log.Println("listening on :8085")
	if err := http.ListenAndServe(":8085", mux); err != nil {
		log.Fatalf("server stopped: %v", err)
	}
}
