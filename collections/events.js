// ======== DB-Model: ========
// _id             -> ID
// region          -> ID_region
// title           -> String
// description     -> String
// start:          -> Date      (Time the events starts)
// end:            -> Date      (Time the event ends)
//
// location {
//       _id:          Optional reference to a document in the Locations collection
//                         If this is set, the fields name, loc, and address are synchronized
//       name:         Descriptive name for the location
//       loc:          Event location in GeoJSON format
//       address:      Address string where the event will take place
// }
// room            -> String    (Where inside the building the event will take place)
// createdby       -> userId
// time_created    -> Date
// time_lastedit   -> Date
// courseId        -> course._id of parent course, optional
// internal        -> Boolean    (Events are only displayed when group or location-filter is active)

// groups          -> list of group._id that promote this event
// groupOrganizers -> list of group._id that are allowed to edit the course

/** Calculated fields
  *
  * courseGroups: list of group._id inherited from course (if courseId is set)
  * allGroups: all groups that promote this course, both inherited from course and set on the event itself
  * editors: list of user and group _id that are allowed to edit the event
  */

// ===========================

Events = new Meteor.Collection("Events");

mayEditEvent = function(user, event) {
	if (!user) return false;
	if (event.createdBy == user._id) return true;
	if (privileged(user, 'admin')) return true;
	if (event.courseId) {
		var course = Courses.findOne({_id: event.courseId, members: {$elemMatch: { user: user._id, roles: 'team' }}});
		if (course) return true;
	}
	return false;
};

affectedReplicaSelectors = function(event) {
	// If the event itself is not in the DB, we don't expect it to have replicas
	if (!event._id) return { _id: -1 }; // Finds nothing

	// Only replicas future from the edited event are updated
	// replicas in the past are never updated
	var futureDate = event.start;
	if (futureDate < new Date()) futureDate = new Date();

	var selector = {
		_id: { $ne: event._id }, // so the event is not considered to be its own replica
		start: { $gte: futureDate }
	};

	if (event.replicaOf) {
		selector.$or = [
			{ replicaOf: event.replicaOf },
			{ _id: event.replicaOf }
		];
	} else {
		selector.replicaOf = event._id;
	}

	return selector;
};

// Sync location fields of the event document
updateEventLocation = function(eventId) {
	untilClean(function() {
		var event = Events.findOne(eventId);
		if (!event) return true; // Nothing was successfully updated, we're done.

		if (typeof event.location != 'object') {
			// This happens only at creation when the field was not initialized correctly
			Events.update(event._id, { $set:{ location: {} }});
			return false;
		}

		var location = false;
		if (event.location._id) {
			location = Locations.findOne(event.location._id);
		}

		var update;
		if (location) {
			// Do not update location for historical events
			if (event.start < new Date()) return true;

			// Sync values to the values set in the location document
			update = { $set: {
				'location.name': location.name,
				'location.address': location.address,
				'location.loc': location.loc
			}};
		} else {
			// If the location vanished we delete the locationId but let the cached fields live on
			update = { $unset: { 'location._id': 1 }};
		}

		// We have to use the Mongo collection API because Meteor does not
		// expose the modification counter
		var r = Events.rawCollection();
		var result = Meteor.wrapAsync(r.update, r)(
			{ _id: event._id },
			update,
			{ fullResult: true }
		);

		return result.nModified === 0;
	});
};


/** @summary recalculate the group-related fields of an event
  * @param {eventId} the event to update
  */
Events.updateGroups = function(eventId) {
	untilClean(function() {
		var event = Events.findOne(eventId);
		if (!event) return true; // Nothing was successfully updated, we're done.

		// The creator of the event as well as any groups listed as organizers
		// are allowed to edit.
		var editors = event.groupOrganizers.slice(); // Clone
		if (event.createdby) editors.push(event.createdby);

		// If an event has a parent course, it inherits all groups and all editors from it.
		var courseGroups = [];
		if (event.courseId) {
			course = Courses.findOne(event.courseId);
			if (!course) throw new Exception("Missing course " + event.courseId + " for event " + event._id);

			courseGroups = course.groups;
			editors = _.union(editors, course.editors);
		}

		var update = {
			editors: editors
		};

		// The course groups are only inherited if the event lies in the future
		// Past events keep their list of groups even if it changes for the course
		var historical = event.start < new Date();
		if (historical) {
			update.allGroups = _.union(event.groups, event.courseGroups);
		} else {
			update.courseGroups = courseGroups;
			update.allGroups = _.union(event.groups, courseGroups);
		}

		var r = Events.rawCollection();
		var result = Meteor.wrapAsync(r.update, r)(
			{ _id: event._id },
			{ $set: update },
			{ fullResult: true }
		);

		return result.nModified === 0;
	});
};


Meteor.methods({
	saveEvent: function(eventId, changes, updateReplicas) {
		check(eventId, String);

		var expectedFields = {
			title:       String,
			description: String,
			location:    Object,
			room:        Match.Optional(String),
			start:       Match.Optional(Date),
			end:         Match.Optional(Date),
			files:       Match.Optional(Array),
			mentors:     Match.Optional(Array),
			host:        Match.Optional(Array),
			replicaOf:   Match.Optional(String),
			courseId:   Match.Optional(String),
			internal:    Match.Optional(Boolean),
			groups:      Match.Optional([String]),
		};

		var isNew = eventId === '';
		if (isNew) {
			expectedFields.region = String;
		}

		check(changes, expectedFields);

		var user = Meteor.user();
		if (!user) {
			if (Meteor.isClient) {
				pleaseLogin();
				return;
			} else {
				throw new Meteor.Error(401, "please log in");
			}
		}

		var now = new Date();

		changes.time_lastedit = now;

		var event = false;
		if (isNew) {
			changes.time_created = now;
			if (changes.courseId && !mayEditEvent(user, changes)) {
				throw new Meteor.Error(401, "not permitted");
			}

			if (!changes.start || changes.start < now) {
				throw new Meteor.Error(400, "Event date in the past or not provided");
			}

			if (changes.courseId) {
				// Inherit groups from the course
				var course = Courses.findOne(changes.courseId);
				changes.groups = course.groups;
			} else {
				var tested_groups = [];
				if (changes.groups) {
					tested_groups = _.map(changes.groups, function(groupId) {
						var group = Groups.findOne(groupId);
						if (!group) throw new Meteor.Error(404, "no group with id "+groupId);
						return group._id;
					});
				}
				changes.groups = tested_groups;
			}

			// Coerce faulty end dates
			if (!changes.end || changes.end < changes.start) {
				changes.end = changes.start;
			}

			changes.internal = !!changes.internal;

			// Synthesize event document because the code below relies on it
			event = { courseId: changes.courseId };

		} else {

			event = Events.findOne(eventId);
			if (!event) throw new Meteor.Error(404, "No such event");
			if (!mayEditEvent(user, event)) throw new Meteor.Error(401, "not permitted");

			// Not allowed to update
			delete changes.replicaOf;
			delete changes.groups;
		}

		// Don't allow moving past events or moving events into the past
		if (!changes.start || changes.start < now) {
			changes.start = event.start;
		}

		if (changes.end && changes.end < changes.start) {
			throw new Meteor.Error(400, "End before start");
		}

		if (Meteor.isServer) {
			changes.description = saneHtml(changes.description);
		}

		if (changes.title) {
			changes.title = saneText(changes.title).substring(0, 1000);
			changes.slug = getSlug(changes.title);
		}

		if (isNew) {
			changes.createdBy = user._id;
			changes.groupOrganizers = [];
			eventId = Events.insert(changes);
		} else {
			Events.update(eventId, { $set: changes });

			if (updateReplicas) {
				delete changes.start;
				delete changes.end;

				Events.update(affectedReplicaSelectors(event), { $set: changes }, { multi: true });
			}
		}

		Meteor.call('updateEventLocation', eventId);
		Meteor.call('event.updateGroups', eventId);

		// the assumption is that all replicas have the same course if any
		if (event.courseId) Meteor.call('updateNextEvent', event.courseId);

		return eventId;
	},


	removeEvent: function(eventId) {
		check(eventId, String);

		var user = Meteor.user();
		if (!user) throw new Meteor.Error(401, "please log in");
		var event = Events.findOne(eventId);
		if (!event) throw new Meteor.Error(404, "No such event");
		if (!mayEditEvent(user, event)) throw new Meteor.Error(401, "not permitted");

		Events.remove(eventId);

		if (event.courseId) Meteor.call('updateNextEvent', event.courseId);

		return Events.findOne({id:eventId}) === undefined;
	},


	removeFile: function(eventId,fileId) {
		check(eventId, String);

		var user = Meteor.user();
		if (!user) throw new Meteor.Error(401, "please log in");
		var event = Events.findOne(eventId);
		if (!event) throw new Meteor.Error(404, "No such event");
		if (!mayEditEvent(user, event)) throw new Meteor.Error(401, "not permitted");

		var tmp = [];

		for(var i = 0; i < event.files.length; i++ ){
			var fileObj = event.files[i];
			if( fileObj._id != fileId){
				tmp.push(fileObj);
			}
		}

		var edits = {
			files: tmp,
		};
		var upd = Events.update(eventId, { $set: edits });
		return upd;
	},

	// Update the location fields for all events matching the selector
	updateEventLocation: function(selector) {
		var idOnly = { fields: { _id: 1 } };
		Events.find(selector, idOnly).forEach(function(event) {
			updateEventLocation(event._id);
		});
	},

	// Update the group-related fields of events matching the selector
	'event.updateGroups': function(selector) {
		var idOnly = { fields: { _id: 1 } };
		Events.find(selector, idOnly).forEach(function(event) {
			Events.updateGroups(event._id);
		});
	},


	/** Add or remove a group from the groups list
	  *
	  * @param {String} eventId - The event to update
	  * @param {String} groupId - The group to add or remove
	  * @param {Boolean} add - Whether to add or remove the group
	  *
	  */
	'event.promote': UpdateMethods.Promote(Events),


	/** Add or remove a group from the groupOrganizers list
	  *
	  * @param {String} eventId - The event to update
	  * @param {String} groupId - The group to add or remove
	  * @param {Boolean} add - Whether to add or remove the group
	  *
	  */
	'event.editing': UpdateMethods.Editing(Events),
});


/* Find events for given filters
 *
 * filter: dictionary with filter options
 *   search: string of words to search for
 *   period: include only events that overlap the given period (list of start and end date)
 *   start: only events that end after this date
 *   before: only events that ended before this date
 *   ongoing: only events that are ongoing during this date
 *   end: only events that started before this date
 *   after: only events starting after this date
 *   location: only events at this location (string match)
 *   room: only events in this room (string match)
 *   standalone: only events that are not attached to a course
 *   region: restrict to given region
 *   categories: list of category ID the event must be in
 *   group: the event must be in that group (ID)
 *   course: only events for this course (ID)
 *   internal: only events that are internal (if true) or public (if false)
 * limit: how many to find
 *
 * The events are sorted by start date (ascending, before-filter causes descending order)
 *
 */
eventsFind = function(filter, limit) {
	var find = {};
	var and = [];
	var options = {
		sort: { start: 1 }
	};

	if (limit > 0) {
		options.limit = limit;
	}

	if (filter.period) {
		find.start = { $lt: filter.period[1] }; // Start date before end of period
		find.end = { $gte: filter.period[0] }; // End date after start of period
	}

	if (filter.start) {
		and.push({ end: { $gte: filter.start } });
	}

	if (filter.end) {
		and.push({ start: { $lte: filter.end } });
	}

	if (filter.after) {
		find.start = { $gt: filter.after };
	}

	if (filter.ongoing) {
		find.start = { $lte: filter.ongoing };
		find.end = { $gte: filter.ongoing };
	}

	if (filter.before) {
		find.end = { $lt: filter.before };
		if (!filter.after) options.sort = { start: -1 };
	}

	if (filter.location) {
		find['location._id'] = filter.location;
	}

	if (filter.room) {
		find.room = filter.room;
	}

	if (filter.standalone) {
		find.courseId = { $exists: false };
	}

	if (filter.region) {
		find.region = filter.region;
	}

	if (filter.categories) {
		find.categories = { $all: filter.categories };
	}

	if (filter.group) {
		find.groups = filter.group;
	}

	if (filter.course) {
		find.courseId = filter.course;
	}

	if (filter.internal !== undefined) {
		find.internal = !!filter.internal;
	}

	if (filter.search) {
		var searchTerms = filter.search.split(/\s+/);
		searchTerms.forEach(function(searchTerm) {
			and.push({ $or: [
				{ title: { $regex: escapeRegex(searchTerm), $options: 'i' } },
				{ description: { $regex: escapeRegex(searchTerm), $options: 'i' } }
			] });
		});
	}

	if (and.length > 0) {
		find.$and = and;
	}

	return Events.find(find, options);
};
