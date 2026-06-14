# Meridian Distributed Database — Operations Guide

This guide covers running a Meridian cluster in production. It assumes you have
already read the overview and understand collections, handles, and the two read
modes.

## Cluster topology

A Meridian cluster is divided into **partitions**. Each partition owns a
contiguous range of document handles and is served by a **replica set** of
three or five nodes. Exactly one node in each replica set is the leader; the
rest are followers. Leadership is decided by a Raft election, and a new leader
is chosen automatically if the current leader stops sending heartbeats for more
than two seconds.

Because writes require a majority acknowledgement, a three-node replica set
tolerates the loss of one node, and a five-node replica set tolerates the loss
of two. Operators choose five-node sets for partitions whose availability
matters most.

## Rebalancing

When a new node joins the cluster, Meridian rebalances by moving whole
partitions, never individual documents. Partition movement copies the
partition's log to the new node in the background and only switches ownership
once the copy has caught up to within one second of the leader. Rebalancing can
be paused with the `meridian balance --pause` command if it is competing with
foreground traffic.

## Backups

Meridian takes incremental backups by shipping each partition's replication log
to object storage every minute. A full restore replays these logs from the most
recent base snapshot. Restores are partition-parallel, so restore time depends
on the size of the largest single partition rather than the size of the whole
cluster.

## Monitoring

The metric operators watch most closely is **replication lag** — the time
between a write being committed on the leader and being applied on the slowest
follower. Sustained lag above five seconds usually means a follower's disk
cannot keep up and the node should be replaced.
