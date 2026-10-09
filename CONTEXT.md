# cua-runner

The language for sending app testing to a desktop that is not the one the person is working on.

## Language

**Desktop**:
One screen an agent can see and drive. It has a single exclusive hold. It is the screen of the machine the runner is installed on.
_Avoid_: Space, sandbox, host

**Runner**:
The process that owns one desktop and offers it to agents.
_Avoid_: driver, daemon

**Holder**:
The label of whoever currently holds the desktop, such as an interactive agent or CI. The label is not a credential.
_Avoid_: user, client, token

**Hold**:
The exclusive right to drive a desktop for a stated purpose, until it is released or it expires. The same holder may refresh it and keeps the same hold.
_Avoid_: lock, login session

**Build**:
A specific artifact of the app, fetched onto the desktop before the agent drives it.
_Avoid_: sandbox image, release

**Relay**:
A meeting point a runner dials out to, so an agent can reach that runner without an inbound port on the runner's network.
_Avoid_: tunnel

**Driver**:
The part that turns a computer tool call into what happens on the screen.
_Avoid_: runner
