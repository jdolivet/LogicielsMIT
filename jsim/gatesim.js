//////////////////////////////////////////////////////////////////////////////
//
//  Gate-level simulation
//
//////////////////////////////////////////////////////////////////////////////

// Copyright (C) 2013 Massachusetts Institute of Technology
// Chris Terman

// this must be loaded *after* jade.js

var gatesim = (function() {

    function dc_analysis(netlist, sweep1, sweep2, options) {
        throw "Sorry, no DC analysis with gate-level simulation";
    }

    function ac_analysis(netlist, fstart, fstop, ac_source_name,options) {
        throw "Sorry, no AC analysis with gate-level simulation";
    }

    // Transient analysis
    //   netlist: JSON description of the circuit
    //   tstop: stop time of simulation in seconds
    //   probe_names: optional list of node names to be checked during LTE calculations
    //   progress_callback(percent_complete,network,msg)
    //      function called periodically, return true to halt simulation
    //      until simulation is complete, network is undefined
    //      message is string reporting any hiccups in simulation
    // network object is returned so UI can access event history for each node
    function transient_analysis(netlist, tstop, probe_names, progress_callback, options) {
        if (netlist.length > 0 && tstop !== undefined) {
            var network = new Network(netlist, options);

            var progress = {};
            progress.update_interval = 250; // in milliseconds
            progress.finish = function(msg) {
                progress_callback(undefined, network, msg);
            };
            progress.stop_requested = false;
            progress.update = function(percent_complete) { // 0 - 100
                // invoke the callback which will return true if the
                // simulation should halt.
                if (progress_callback(percent_complete, undefined, undefined)) progress.stop_requested = true;
            };

            network.initialize(progress, tstop);
            try {
                network.simulate(new Date().getTime() + network.progress.update_interval);
            }
            catch (e) {
                if (typeof e == 'string') progress.finish(e);
                else throw e;
            }
        }
    }

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Network
    //
    //////////////////////////////////////////////////////////////////////////////

    function Network(netlist, options) {
        this.N = 0;
        this.node_map = {};
        this.nodes = [];
        this.devices = []; // list of devices
        this.device_map = {}; // name -> device
        this.event_queue = new Heap();
        this.options = options;

        if (netlist !== undefined) this.load_netlist(netlist);
    }

    // return Node object for specified name, create if necessary
    Network.prototype.node = function(name) {
        var n = this.node_map[name];
        if (n === undefined) {
            n = new Node(name, this);
            this.node_map[name] = n;
            this.nodes.push(n);
            this.N += 1;
        }
        return n;
    };

    // load circuit from JSON netlist: [[device,[connections,...],{prop: value,...}]...]
    Network.prototype.load_netlist = function(netlist) {
        // process each component in the JSON netlist (see schematic.js for format)
        var counts = {};
        var n,d;
        for (var i = netlist.length - 1; i >= 0; i -= 1) {
            var component = netlist[i];
            var type = component.type;
            var connections = component.connections;
            var properties = component.properties;
	    counts[type] = (counts[type] || 0) + 1;

            // convert node names to Nodes
            for (var c in connections) connections[c] = this.node(connections[c]);

            // process the component
            var name = properties.name;
            if (type in logic_gates) {
                var info = logic_gates[type]; // [input-list,output,table]
                // build input and output lists using terminal names
                // in info array
                var inputs = [];
                for (var j = 0; j < info[0].length; j += 1) inputs.push(connections[info[0][j]]);
                // create a new device
                d = new LogicGate(this, type, name, info[2], inputs, connections[info[1]], properties);
                this.devices.push(d);
                this.device_map[name] = d;
            }
            else if (type == 'dlatch') {
                throw "Device "+type+" not yet implemented in gatesim";
            }
            else if (type == 'dlatchn') {
                throw "Device "+type+" not yet implemented in gatesim";
            }
            else if (type == 'dreg') {
                throw "Device "+type+" not yet implemented in gatesim";
            }
            else if (type == 'memory') {
                throw "Device "+type+" not yet implemented in gatesim";
            }
            else if (type == 'ground') {
                // gnd node -- drive with a 0-input OR gate (output = 0)
                n = connections.gnd;
                if (n.drivers.length > 0) continue; // already handled this one
                n.v = V0;   // should be set by initialization of LogicGate that drives this node
                this.devices.push(new LogicGate(this, type, name, LTable, [], n, properties));
            }
            else if (type == 'constant0' || type == 'constant1') {
                n = connections.z;
                if (n.drivers.length > 0) continue; // already handled this one
                n.v = (type == 'constant0' ? V0 : V1);   // should be set by initialization of LogicGate that drives this node
                this.devices.push(new LogicGate(this, type, name, type == 'constant0' ? LTable:HTable, [], n, properties));
            }
            else if (type == 'voltage source') {
                n = connections.nplus; // hmmm.
                if (n.drivers.length > 0) continue; // already handled this one
                this.devices.push(new Source(this, name,  n, properties, true));
            }
            else throw 'Unrecognized gate: ' + type;
        }

        // give each Node a chance to finalize itself
        for (n in this.node_map) this.node_map[n].finalize();

        var msg = this.N.toString() + ' nodes';
        for (d in counts) msg += ', ' + counts[d].toString() + ' ' + d;
        console.log(msg);
    };

    // initialize for simulation, queue initial events
    Network.prototype.initialize = function(progress, tstop) {
        this.progress = progress;
        this.tstop = tstop;
        this.event_queue.clear();
        this.time = 0;

        // initialize nodes
        var i;
        for (i = 0; i < this.nodes.length; i += 1) this.nodes[i].initialize();

        // queue initial events
        for (i = 0; i < this.devices.length; i += 1) this.devices[i].initialize();
    };

    // tupdate is the wall-clock time at which we should take a quick coffee break
    // to let the UI update
    Network.prototype.simulate = function(tupdate) {
        var ecount = 0;
        if (!this.progress.stop_requested) // halt when user clicks stop
        while (this.time < this.tstop && !this.event_queue.empty()) {
            var event = this.event_queue.pop();
	    this.time = event.time;
            event.node.process_event(event, false);

            // check for coffee break every 1000 events
            if (++ecount < 1000) continue;
            else ecount = 0;

            var t = new Date().getTime();
            if (t >= tupdate) {
                // update progress bar
                var completed = Math.round(100 * this.time / this.tstop);
                this.progress.update(completed);

                // a brief break in the action to allow progress bar to update
                // then pick up where we left off
                var nl = this;
                setTimeout(function() {
                    try {
                        nl.simulate(t + nl.progress.update_interval);
                    }
                    catch (e) {
                        if (typeof e == 'string') nl.progress.finish(e);
                        else throw e;
                    }
                }, 1);

                // our portion of the work is done
                return;
            }
        }

        // simulation complete or interrupted
        this.progress.finish(undefined);
    };

    Network.prototype.add_event = function(t, type, node, v) {
        var event = new Event(t, type, node, v);
        this.event_queue.push(event);
        return event;
    };

    Network.prototype.remove_event = function(event) {
        this.event_queue.removeItem(event);
    };
    
    // return event list for specified node.  Each event has the following
    // attributes:
    //   time: time of the event in seconds
    //   type: 0=contaminate event, 1 = propagate event
    //   v: value of node after event
    //   old_v: value of node before event
    //   node: Node object
    Network.prototype.history = function(node) {
        var n = this.node_map[node];
        if (n === undefined) return undefined;
        else return n.history;
    };

    // return list of node's events, undefined if node has no events.
    // event objects have the following attributes:
    //   time: time of event
    //   type: 0=contaminate 1=propagate
    //   v: value of node after event (0=0, 1=1, 2=X, 3=Z)
    //   old_v: value of node before event
    //   node: corresponding Node object
    Network.prototype.history = function(node) {
        var n = this.node_map[node];
        if (n === undefined) return undefined;
        else return n.history;
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Events & the event heap
    //
    //////////////////////////////////////////////////////////////////////////////

    var CONTAMINATE = 0; // values chosen so that C events sort before P events
    var PROPAGATE = 1;

    function Event(t, type, node, v) {
        this.time = t; // time of event
        this.type = type; // CONTAMINATE, PROPAGATE
        this.node = node;
        this.v = v;
    }

    // Heaps are arrays for which a[k] <= a[2*k+1] and a[k] <=
    // a[2*k+2] for all k, counting elements from 0.  For the sake
    // of comparison, non-existing elements are considered to be
    // infinite.  The interesting property of a heap is that a[0]
    // is always its smallest element.
    // stolen from Python's heapq.py
    function Heap() {
        this.nodes = [];
    }

    // specialized for events...
    Heap.prototype.cmplt = function(e1, e2) {
        return e1.time < e2.time;
    };

    // 'heap' is a heap at all indices >= startpos, except possibly for pos.  pos
    // is the index of a leaf with a possibly out-of-order value.  Restore the
    // heap invariant.
    Heap.prototype._siftdown = function(startpos, pos) {
        var newitem, parent, parentpos;
        newitem = this.nodes[pos];
        // follow th epath to the root
        while (pos > startpos) {
            parentpos = (pos - 1) >> 1;
            parent = this.nodes[parentpos];
            if (this.cmplt(newitem, parent)) {
                this.nodes[pos] = parent;
                pos = parentpos;
                continue;
            }
            break;
        }
        this.nodes[pos] = newitem;
    };

    // The child indices of heap index pos are already heaps, and we want to make
    // a heap at index pos too.  We do this by bubbling the smaller child of
    // pos up (and so on with that child's children, etc) until hitting a leaf,
    // then using _siftdown to move the oddball originally at index pos into place.
    Heap.prototype._siftup = function(pos) {
        var childpos, endpos, newitem, rightpos, startpos;
        endpos = this.nodes.length;
        startpos = pos;
        newitem = this.nodes[pos];
        // bubble up the smaller child until hitting a leaf
        childpos = 2 * pos + 1;
        while (childpos < endpos) {
            // set childpos to index of smaller child
            rightpos = childpos + 1;
            if (rightpos < endpos && !(this.cmplt(this.nodes[childpos], this.nodes[rightpos]))) {
                childpos = rightpos;
            }
            // move the smaller child up
            this.nodes[pos] = this.nodes[childpos];
            pos = childpos;
            childpos = 2 * pos + 1;
        }
        // the leaf at pos is empty now.  Put newitem there and bubble it up
        // to its final resitng place (by sifting its parents down)
        this.nodes[pos] = newitem;
        this._siftdown(startpos, pos);
    };

    // add new item to the heap
    Heap.prototype.push = function(item) {
        this.nodes.push(item);
        this._siftdown(0, this.nodes.length - 1);
    };

    // remove smallest item from the head
    Heap.prototype.pop = function() {
        var lastelt, returnitem;
        lastelt = this.nodes.pop();
        if (this.nodes.length) {
            returnitem = this.nodes[0];
            this.nodes[0] = lastelt;
            this._siftup(0);
        }
        else {
            returnitem = lastelt;
        }
        return returnitem;
    };

    // see what smallest item is without removing it
    Heap.prototype.peek = function() {
        return this.nodes[0];
    };

    // is item on the heap?
    Heap.prototype.contains = function(item) {
        return this.nodes.indexOf(item) !== -1;
    };

    // rebuild heap after changing an item in the heap
    Heap.prototype.updateItem = function(item) {
        var pos = this.nodes.indexOf(item);
        if (pos != -1) {
            this._siftdown(0, pos);
            this._siftup(pos);
        }
    };

    // remove an item from the head
    Heap.prototype.removeItem = function(item) {
        var pos = this.nodes.indexOf(item);
        if (pos != -1) {
            // replace item to be removed with last element of heap
            // then sift it up to where it belongs
            var lastelt = this.nodes.pop();
            if (this.nodes.length) {
                this.nodes[pos] = lastelt;
                this._siftup(pos);
            }
        }
    };

    // clear the heap
    Heap.prototype.clear = function() {
        return this.nodes = [];
    };

    // is the heap empty?
    Heap.prototype.empty = function() {
        return this.nodes.length === 0;
    };

    // how many items on the heap?
    Heap.prototype.size = function() {
        return this.nodes.length;
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Node
    //
    //////////////////////////////////////////////////////////////////////////////

    var V0 = 0; // node values
    var V1 = 1;
    var VX = 2;
    var VZ = 3;

    var c_slope = 0; // F/terminal of interconnect capacitance
    var c_intercept = 0; // F of interconnect capacitance

    function Node(name, network) {
        this.name = name;
        this.network = network;

        this.drivers = []; // devices which want to control value of this node
        this.driver = undefined; // device which controls value of this node
        this.fanouts = []; // devices with this node as an input
        this.capacitance = 0; // nodal capacitance
    }

    Node.prototype.initialize = function() {
        this.v = VX;
        this.times = []; // history of events
        this.values = [];
        this.cd_event = undefined; // contamination delay event for this node
        this.pd_event = undefined; // propagation delay event for this node

        // for timing analysis
        this.clock = false; // is this node connected to clock input of state device
        this.timing_info = undefined; // min tCD, max tPD for this node
        this.in_progress = false; // flag to catch combinational cycles
    };

    Node.prototype.add_fanout = function(device) {
        if (this.fanouts.indexOf(device) == -1) this.fanouts.push(device);
    };

    Node.prototype.add_driver = function(device) {
        this.drivers.push(device);
    };

    Node.prototype.process_event = function(event, force) {
        // update event pointers
        if (event == this.cd_event) this.cd_event = undefined;
        else if (event == this.pd_event) this.pd_event = undefined;

        if (this.v != event.v || force) {
	    this.times.push(event.time);
	    this.values.push(this.v*4 + event.v);   // remember both previous and new values

            this.v = event.v;
	    //console.log(this.name + ": " + "01XZ"[event.old_v] + "->" + "01XZ"[event.v] + " @ " + (event.time * 1e9).toFixed(2));

            // let fanouts know our value changed
            for (var i = this.fanouts.length - 1; i >= 0; i -= 1)
            this.fanouts[i].process_event(event);
        }
    };

    Node.prototype.finalize = function() {
        if (this.drivers === undefined || this.driver !== undefined) return; // already finalized

        // if no explicit capacitance has been supplied, estimate
        // interconnect capacitance
        var ndrivers = this.drivers.length;
        var nfanouts = this.fanouts.length;
        if (ndrivers === 0 && nfanouts > 0) throw 'Node ' + this.name + ' is not connected to any output.';
        if (this.capacitance === 0) this.capacitance = c_intercept + c_slope * (ndrivers + nfanouts);

        // add capacitances from drivers and fanout connections
        var i,d;
        for (i = 0; i < ndrivers; i += 1)
        this.capacitance += this.drivers[i].capacitance(this);
        for (i = 0; i < nfanouts; i += 1)
        this.capacitance += this.fanouts[i].capacitance(this);

        // if there is only 1 driver and it's not a tristate output
        // then that device is the driver for this node
        if (ndrivers == 1) {
            d = this.drivers[0];
            if (!d.tristate(this)) {
                this.driver = d;
                this.drivers = undefined;
                return;
            }
        }

        // handle tristates and multiple drivers by adding a special BUS
        // device that computes value from all the drivers
        var inputs = [];
        for (i = 0; i < ndrivers; i += 1) {
            d = this.drivers[i];
            if (!d.tristate(this)) {
                // shorting together non-tristate outputs, so complain
                var msg = 'Node ' + this.name + ' connects to more than one non-tristate output.  See devices: \n';
                for (var j = 0; j < ndrivers; j += 1)
                msg += this.drivers[j].name + '\n';
                throw msg;
            }
            // cons up a new node and have this device drive it
            var n = new Node(this.network, this.name + '%' + i.toString());
            n.capacitance = this.capacitance; // each driver has to drive all the capacitance
            inputs.push(n);
            d.change_output_node(this, n);
            n.driver = d;
        }

        // now add the BUS device to drive the current node
        this.driver = new LogicGate(this.network, 'BUS', this.name + '%bus', BusTable, inputs, this, {}, true);
        this.drivers = undefined; // finalization complete
        this.network.devices.push(this.driver);
    };

    // schedule contamination event for this node
    Node.prototype.c_event = function(tcd) {
        var t = this.network.time + tcd;

        // remove any pending propagation event that happens after tcd
        if (this.pd_event && this.pd_event.time >= t) {
            this.network.remove_event(this.pd_event);
            this.pd_event = undefined;
        }

        // if we've already scheduled a contamination event for an earlier
        // time, make the conservative assumption that node will become
        // contaminated at the earlier possible time, i.e., keep the
        // earlier of the two contamination events
        if (this.cd_event) {
            if (this.cd_event.time <= t) return;
            this.network.remove_event(this.cd_event);
        }

        this.cd_event = this.network.add_event(t, CONTAMINATE, this, VX);
    };

    // schedule propagation event for this node
    Node.prototype.p_event = function(tpd, v, drive, lenient) {
        var t = this.network.time + tpd + drive * this.capacitance;

        if (this.pd_event) {
            if (lenient && this.pd_event.v == v && t >= this.pd_event.time) return;
            this.network.remove_event(this.pd_event);
        }

        this.pd_event = this.network.add_event(t, PROPAGATE, this, v);
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Sources
    //
    ///////////////////////////////////////////////////////////////////////////////

    function Source(network, name, output, properties) {
        this.network = network;
        this.name = name;
        this.output = output;

        this.vil = network.options.vil || 0.1;
        this.vih = network.options.vih || 0.9;

        var v = properties.value;
        if (v.type == 'dc') {
            this.tvpairs = [0, v.args[0]];   // single t,v pair
        } else if (v.type == 'pwl') {
            this.tvpairs = v.args;
            this.initial_value = v.args[1];
        } else throw "Unrecognized source type "+v.type;

        // figure out initial value from first t,v pair
        this.initial_value = this.tvpairs[1] <= this.vil ? V0 : (this.tvpairs[1] >= this.vih ? V1 : VX);

	output.add_fanout(this);    // listen for our own events!
        output.add_driver(this);
    }

    Source.prototype.initialize = function() {
        if (this.initial_value != VX)
            this.output.p_event(0,this.initial_value,0,false);
    };

    Source.prototype.capacitance = function(node) {
        return 0;
    };

    // is node a tristate output of this device?
    Source.prototype.tristate = function(node) {
        return false;
    };

    // figure out next event for source -- triggered by last event!
    Source.prototype.process_event = function(event) {
        var time = this.network.time;
        var t,v;

	// propagate events on source's output cause new events
	// to be scheduled for *next* source transition
        if (event.type == PROPAGATE) {
            t = this.next_contamination_time(time);
            if (t >= 0) this.output.c_event(t - time);

            t = this.next_propagation_time(time);
            if (t.time > 0) this.output.p_event(t.time - time, t.value, 0, false);
	    //console.log(this.output.name + ": "+(t.time * 1e9).toFixed(2) + ' -> ' + "01XZ"[t.value]);
        }
    };

    // return time of next contamination event for pwl source
    Source.prototype.next_contamination_time = function(time) {
        time += 1e-13;  // get past current time by epsilon
        var tlast = 0;
        var vlast = 0;
        var npairs = this.tvpairs.length / 2;
        var et;
        for (var i = 0; i < npairs; i += 2) {
            var t = this.tvpairs[i];
            var v = this.tvpairs[i+1];
            if (i > 0 && time <= t) {
                if (vlast >= this.vih && v < this.vih) {
                    et = tlast + (t - tlast)*(this.vih - vlast)/(v - vlast);
                    if (et > time) return et;
                }
                else if (vlast <= this.vil && v > this.vil) {
                    et = tlast + (t - tlast)*(this.vil - vlast)/(v - vlast);
                    if (et > time) return et;
                }
            }
            tlast = t;
            vlast = v;
        }
        return -1;
    };

    // return {time:t, value: v} of next propagation event for pwl source
    Source.prototype.next_propagation_time = function (time) {
        time += 1e-13;  // get past current time by epsilon
        var tlast = 0;
        var vlast = 0;
        var npairs = this.tvpairs.length / 2;
        var et;
        for (var i = 0; i < npairs; i += 2) {
            var t = this.tvpairs[i];
            var v = this.tvpairs[i+1];
            if (i > 0 && time <= t) {
                if (vlast < this.vih && v >= this.vih) {
                    et = tlast + (t - tlast)*(this.vih - vlast)/(v - vlast);
                    if (et > time) return {time: et, value: V1};
                }
                else if (vlast > this.vil && v <= this.vil) {
                    et = tlast + (t - tlast)*(this.vil - vlast)/(v - vlast);
                    if (et > time) return {time: et, value: V0};
                }
            }
            tlast = t;
            vlast = v;
        }
        return {time: -1};
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Logic gates
    //
    ///////////////////////////////////////////////////////////////////////////////

    // it's tables all the way down
    // use current input as index into current table to get new table
    // repeat until all inputs have been consumed
    // final value is given by current_table[4]

    var LTable = [];
    LTable.push(LTable, LTable, LTable, LTable, 0); // always "0"
    var HTable = [];
    HTable.push(HTable, HTable, HTable, HTable, 1); // always "1"
    var XTable = [];
    XTable.push(XTable, XTable, XTable, XTable, 2); // always "X"
    var ZTable = [];
    ZTable.push(ZTable, ZTable, ZTable, ZTable, 3); // always "Z"
    var SelectTable = [LTable, HTable, XTable, XTable, 2]; // select this input
    var Select2ndTable = [SelectTable, SelectTable, SelectTable, SelectTable, 2]; // select second input
    var Select3rdTable = [Select2ndTable, Select2ndTable, Select2ndTable, Select2ndTable, 2]; // select third input
    var Select4thTable = [Select3rdTable, Select3rdTable, Select3rdTable, Select3rdTable, 2]; // select fourth input
    var Ensure0Table = [LTable, XTable, XTable, XTable, 2]; // must be 0
    var Ensure1Table = [XTable, HTable, XTable, XTable, 2]; // must be 1
    var EqualTable = [Ensure0Table, Ensure1Table, XTable, XTable, 2]; // this == next

    // tristate bus resolution
    // produces "Z" if all inputs are "Z"
    // produces "1" if one input is "1" and other inputs are "1" or "Z"
    // produces "0" if one input is "0" and other inputs are "0" or "Z"
    // produces "X" otherwise
    var BusTable = [];
    var Bus0Table = [];
    var Bus1Table = [];
    BusTable.push(Bus0Table, Bus1Table, XTable, BusTable, 3);
    Bus0Table.push(Bus0Table, XTable, XTable, Bus0Table, 0);
    Bus1Table.push(XTable, Bus1Table, XTable, Bus1Table, 1);

    // tristate buffer (node order: enable,in)
    var TristateBufferTable = [ZTable, SelectTable, XTable, XTable, 2];

    // and tables
    var AndXTable = [];
    AndXTable.push(LTable, AndXTable, AndXTable, AndXTable, 2);
    var AndTable = [];
    AndTable.push(LTable, AndTable, AndXTable, AndXTable, 1);

    // nand tables
    var NandXTable = [];
    NandXTable.push(HTable, NandXTable, NandXTable, NandXTable, 2);
    var NandTable = [];
    NandTable.push(HTable, NandTable, NandXTable, NandXTable, 0);

    // or tables
    var OrXTable = [];
    OrXTable.push(OrXTable, HTable, OrXTable, OrXTable, 2);
    var OrTable = [];
    OrTable.push(OrTable, HTable, OrXTable, OrXTable, 0);

    // nor tables
    var NorXTable = [];
    NorXTable.push(NorXTable, LTable, NorXTable, NorXTable, 2);
    var NorTable = [];
    NorTable.push(NorTable, LTable, NorXTable, NorXTable, 1);

    // xor tables
    var XorTable = [];
    var Xor1Table = [];
    XorTable.push(XorTable, Xor1Table, XTable, XTable, 0);
    Xor1Table.push(Xor1Table, XorTable, XTable, XTable, 1);
    var XnorTable = [];
    var Xnor1Table = [];
    XnorTable.push(XnorTable, Xnor1Table, XTable, XTable, 1);
    Xnor1Table.push(Xnor1Table, XnorTable, XTable, XTable, 0);

    // 2-input mux table (node order: sel,d0,d1)
    var Mux2Table = [SelectTable, Select2ndTable, EqualTable, EqualTable, 2];

    // 4-input mux table (node order: s0,s1,d0,d1,d2,d3)
    var Mux4aTable = [SelectTable, Select3rdTable, EqualTable, EqualTable, 2]; // s0 == 0
    var Mux4bTable = [Select2ndTable, Select4thTable, EqualTable, EqualTable, 2]; // s0 == 1
    var Mux4Table = [Mux4aTable, Mux4bTable, EqualTable, EqualTable, 2];

    // for each logic gate provide [input-terminal-list,output-terminal,table]
    var logic_gates = {
        'and2': [['a', 'b'], 'z', AndTable],
        'and3': [['a', 'b', 'c'], 'z', AndTable],
        'and4': [['a', 'b', 'c', 'd'], 'z', AndTable],
        'buffer': [['a'], 'z', AndTable],
        'inv': [['a'], 'z', NandTable],
        'mux2': [['s', 'd0', 'd1'], 'z', Mux2Table],
        'mux4': [['s0', 's1', 'd0', 'd1', 'd2', 'd3'], 'z', Mux4Table],
        'nand2': [['a', 'b'], 'z', NandTable],
        'nand3': [['a', 'b', 'c'], 'z', NandTable],
        'nand4': [['a', 'b', 'c', 'd'], 'z', NandTable],
        'nor2': [['a', 'b'], 'z', NorTable],
        'nor3': [['a', 'b', 'c'], 'z', NorTable],
        'nor4': [['a', 'b', 'c', 'd'], 'z', NorTable],
        'or2': [['a', 'b'], 'z', OrTable],
        'or3': [['a', 'b', 'c'], 'z', OrTable],
        'or4': [['a', 'b', 'c', 'd'], 'z', OrTable],
        'tristate': [['e', 'a'], 'z', TristateBufferTable],
        'xor2': [['a', 'b'], 'z', XorTable],
        'xnor2': [['a', 'b'], 'z', XnorTable]
    };

    function LogicGate(network, type, name, table, inputs, output, properties) {
        this.network = network;
        this.type = type;
        this.name = name;
        this.table = table;
        this.inputs = inputs;
        this.output = output;
        this.properties = properties;

        this.lenient = properties.lenient !== undefined && properties.lenient !== 0;

        for (var i = 0; i < inputs.length ; i+= 1) inputs[i].add_fanout(this);
        output.add_driver(this);

        if (this.properties.cout === undefined) this.properties.cout = 0;
        if (this.properties.cin === undefined) this.properties.cin = 0;
        if (this.properties.tcd === undefined) this.properties.tcd = 0;
        if (this.properties.tpdf === undefined) this.properties.tpdf = 0;
        if (this.properties.tpdr === undefined) this.properties.tpdr = 0;
        if (this.properties.tr === undefined) this.properties.tr = 0;
        if (this.properties.tf === undefined) this.properties.tf = 0;

        var in0 = inputs[0];
        var in1 = inputs[1];
        var in2 = inputs[2];
        var in3 = inputs[3];
        var in4 = inputs[4];
        var in5 = inputs[5];
        if (inputs.length === 0) this.logic_eval = function() {
            return table[4];
        };
        else if (inputs.length == 1) this.logic_eval = function() {
            return table[in0.v][4];
        };
        else if (inputs.length == 2) this.logic_eval = function() {
            return table[in0.v][in1.v][4];
        };
        else if (inputs.length == 3) this.logic_eval = function() {
            return table[in0.v][in1.v][in2.v][4];
        };
        else if (inputs.length == 4) this.logic_eval = function() {
            return table[in0.v][in1.v][in2.v][in3.v][4];
        };
        else if (inputs.length == 5) this.logic_eval = function() {
            return table[in0.v][in1.v][in2.v][in3.v][in4.v][4];
        };
        else if (inputs.length == 6) this.logic_eval = function() {
            return table[in0.v][in1.v][in2.v][in3.v][in4.v][in5.v][4];
        };
        else this.logic_eval = function() {
                // handles arbitrary numbers of inputs (eg, for BusTable).
                var t = table;
                for (var i = 0; i < inputs.length ; i+= 1) t = t[inputs[i].v];
                return t[4];
            };
    }

    LogicGate.prototype.initialize = function() {
        if (this.inputs.length === 0) {
            // gates with no inputs will produce a constant output, so
            // figure that out now and process the appropriate event
            var v = this.logic_eval();
            this.output.process_event(new Event(0, PROPAGATE, this.output, v), true);
        }
    };

    LogicGate.prototype.capacitance = function(node) {
        if (this.output == node) return this.properties.cout;
        else return this.properties.cin;
    };

    // is node a tristate output of this device?
    LogicGate.prototype.tristate = function(node) {
        if (this.output == node && this.table == TristateBufferTable) return true;
        else return false;
    };

    // evaluation of output values triggered by an event on the input
    LogicGate.prototype.process_event = function(event) {
        var onode = this.output;
        var v;
        if (event.type == CONTAMINATE) {
            // a lenient gate won't contaminate the output under the right circumstances
            if (this.lenient) {
                v = this.logic_eval();
                if (onode.pd_event === undefined) {
                    // no events pending and current value is same as new value
                    if (onode.cd_event === undefined && v == onode.v) return;
                }
                else {
                    // node is destined to have the same value as new value
                    if (v == onode.pd_event.v) return;
                }
            }

            // schedule contamination event with specified delay
            onode.c_event(this.properties.tcd);
        }
        else if (event.type == PROPAGATE) {
            v = this.logic_eval();
            if (!this.lenient || v != onode.v || onode.cd_event !== undefined || onode.pd_event !== undefined) {
                var drive, tpd;
                if (v == V1) {
                    tpd = this.properties.tpdr;
                    drive = this.properties.tr;
                }
                else if (v == V0) {
                    tpd = this.properties.tpdf;
                    drive = this.properties.tf;
                }
                else {
                    tpd = Math.min(this.properties.tpdr, this.properties.tpdf);
                    drive = 0;
                }
                onode.p_event(tpd, v, drive, this.lenient);
            }
        }
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Module definition
    //
    ///////////////////////////////////////////////////////////////////////////////
    var module = {
        'dc_analysis': dc_analysis,
        'ac_analysis': ac_analysis,
        'transient_analysis': transient_analysis
    };
    return module;
}());