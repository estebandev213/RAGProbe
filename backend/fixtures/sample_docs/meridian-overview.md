# Meridian Distributed Database — Overview

Meridian is a distributed document database built for read-heavy analytical
workloads. It was first released in 2019 by Halcyon Systems and is written in
Rust. The project is named after the Meridian Arc survey, a 19th-century
geodetic effort, because its authors saw indexing as a kind of surveying.

## Data model

Meridian stores data as **collections** of JSON documents. Every document is
assigned an immutable 128-bit identifier called a _handle_ when it is first
written. Handles are never reused, even after a document is deleted, which lets
the replication log refer to documents unambiguously for the lifetime of a
cluster.

A collection may declare up to 64 **secondary indexes**. Indexes are built
asynchronously by background workers, so a freshly declared index does not
block writes while it is being populated. Queries automatically fall back to a
full collection scan when no suitable index exists.

## Consistency

Meridian offers two read modes. **Linearizable reads** are routed to the
partition leader and always reflect the most recent committed write.
**Snapshot reads** are served from any replica and reflect a consistent point
in time that may lag the leader by a few seconds. Snapshot reads are the
default because most analytical queries tolerate slight staleness in exchange
for lower latency and higher throughput.

Writes are always linearizable. A write is acknowledged to the client only
after a majority of replicas in the partition's replica set have durably
persisted it to their local log.

## Licensing

Meridian Community Edition is open source under the Apache 2.0 license.
Meridian Enterprise adds encryption at rest, audit logging, and priority
support, and is sold under an annual subscription.
